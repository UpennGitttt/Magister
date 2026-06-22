import { describe, expect, test } from "bun:test";

import { isReadOnlyBashCommand } from "../../../../src/services/manager-automation/autonomous-loop/plan-mode-bash-classifier";

// ALLOW table — commands that should pass.
const ALLOW: string[] = [
  // Pure reads
  "ls",
  "ls /tmp",
  "ls -la /var/log",
  "cat package.json",
  "cat /etc/hosts",
  "head -n 20 README.md",
  "tail -f /var/log/syslog",
  "wc -l src/main.ts",
  "find . -name '*.ts'",
  "grep -r foo src/",
  "rg foo src/",
  "pwd",
  "echo hello",
  "echo hello > /dev/null",
  "echo hello > /dev/stderr",
  "cat file > /dev/null 2>&1",
  "true",
  "false",
  // Test
  "[ -f /tmp/foo ]",
  "test -d /tmp",
  // Version / help
  "node --version",
  "bun --version",
  "git --version",
  // git read
  "git status",
  "git diff",
  "git log --oneline -10",
  "git show HEAD",
  "git ls-files",
  "git rev-parse HEAD",
  "git config --get user.email",
  "git stash list",
  "git remote",
  "git fetch --dry-run",
  // Pipes between safe commands
  "ls | wc -l",
  "cat package.json | jq .name",
  "grep foo src/ | head -5",
  "git status && git diff",
  // Env-prefixed safe call
  "FOO=bar ls /tmp",
  "env ls",
  // sed/awk without -i
  "sed 's/foo/bar/' file",
  "awk '{print $1}' file",
];

// DENY table — commands that should be rejected.
const DENY: string[] = [
  // Write redirects
  "echo hi > file.txt",
  "echo hi >> file.txt",
  "git diff > patch.txt",
  "cat foo > /tmp/out",
  "ls | tee /tmp/log",
  "echo x > /tmp/y && cat /tmp/y",

  // File ops
  "touch newfile",
  "rm -rf /tmp/foo",
  "mv old new",
  "cp src dst",
  "mkdir new_dir",
  "rmdir old_dir",
  "chmod +x script.sh",
  "chown user file",
  "ln -s a b",
  "truncate -s 0 file",

  // In-place edits
  "sed -i 's/a/b/' file",
  "sed --in-place 's/a/b/' file",
  "awk -i inplace '{print}' file",
  "perl -i -pe 's/a/b/' file",

  // Package managers
  "npm install foo",
  "bun install",
  "pip install requests",
  "pip3 install foo",
  "yarn add lodash",
  "pnpm add bar",
  "cargo install ripgrep",
  "apt install vim",
  "apt-get install vim",
  "brew install jq",
  "make",
  "make install",

  // Arbitrary code execution
  "node -e \"require('fs').writeFileSync('x', '')\"",
  "node --eval \"console.log(1)\"",
  "python -c \"open('x','w').write('')\"",
  "python3 -c print(1)",
  "perl -e 'print 1'",
  "ruby -e 'puts 1'",
  "bash -c 'rm -rf /'",
  "sh -c 'echo hi > /tmp/x'",
  "zsh -c 'echo hi'",
  "eval 'ls'",
  "exec ls",
  // Backtick substitution
  "echo `whoami`",
  "ls `pwd`",

  // git mutations
  "git commit -m 'foo'",
  "git push",
  "git pull",
  "git merge main",
  "git checkout main",
  "git reset --hard",
  "git rebase main",
  "git add .",
  "git stash",
  "git stash push",
  "git tag -d v1.0",
  "git branch -d feature",
  "git config user.name 'foo'",
  "git remote add origin foo",
  "git fetch origin",

  // Docker mutating
  "docker run alpine",
  "docker exec -it foo bash",
  "docker build .",
  "docker push image",

  // sudo
  "sudo ls",
  "sudo apt install vim",

  // Process kill
  "kill 1234",
  "pkill node",
  "killall bun",

  // Network mutating curl/wget
  "curl -o file.zip https://example.com/foo.zip",
  "curl -X POST -d '{}' https://example.com/api",
  "wget -O file.html https://example.com",

  // Heredoc to file
  "cat <<EOF > /tmp/file.txt\nhi\nEOF",

  // Unknown command (default-deny)
  "do_something_unusual --flag",
  "rsync src dst",        // not in allowlist
  "scp file remote:path", // not in allowlist

  // Global-option bypasses — these all routed through the allowlist
  // before the tokenizer rewrite (regression coverage for Codex
  // re-review findings).
  "git -C /tmp/repo commit -m foo",
  "git -c user.email=x commit -m foo",
  "git --git-dir=/tmp/.git push",
  "git --work-tree=/tmp checkout main",
  "npm --prefix /tmp install",
  "bun --cwd /tmp install",
  "pnpm -w install",
  "yarn --cwd /tmp add foo",
  "pip --prefix /tmp install requests",
  "cargo --manifest-path /tmp/Cargo.toml publish",

  // Allowlisted tools with mutating flags
  "find /tmp -delete",
  "find /tmp -exec rm {} \\;",
  "find /tmp -execdir rm {} \\;",
  "sort -o out.txt in.txt",
  "sort --output=out.txt in.txt",
];

describe("isReadOnlyBashCommand", () => {
  describe("ALLOW", () => {
    for (const cmd of ALLOW) {
      test(`accepts: ${cmd}`, () => {
        expect(isReadOnlyBashCommand(cmd)).toBe(true);
      });
    }
  });

  describe("DENY", () => {
    for (const cmd of DENY) {
      test(`rejects: ${cmd}`, () => {
        expect(isReadOnlyBashCommand(cmd)).toBe(false);
      });
    }
  });

  describe("edge cases", () => {
    test("empty string is rejected", () => {
      expect(isReadOnlyBashCommand("")).toBe(false);
      expect(isReadOnlyBashCommand("   ")).toBe(false);
    });

    test("whitespace is normalized", () => {
      expect(isReadOnlyBashCommand("   ls /tmp   ")).toBe(true);
    });

    test("compound deny wins over allow segment", () => {
      // First segment is allowed, second is not — must reject the whole thing.
      expect(isReadOnlyBashCommand("git status && rm -rf /tmp/x")).toBe(false);
    });

    test("compound deny via pattern wins regardless of segment split", () => {
      // The deny pattern scans the full command, so even something
      // weird like a write redirect inside a sub-shell substitution
      // gets caught.
      expect(isReadOnlyBashCommand("ls $(echo > file.txt)")).toBe(false);
    });

    test("redirect to /dev/null is allowed even when full command would otherwise be flagged by `>`", () => {
      expect(isReadOnlyBashCommand("ls 2>/dev/null")).toBe(true);
      expect(isReadOnlyBashCommand("cat foo > /dev/null")).toBe(true);
    });
  });
});
