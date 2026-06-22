#!/bin/zsh
set -euo pipefail

if [ "$#" -lt 5 ]; then
  echo "usage: $0 <model> <note_path> <label> <prompt> <file1> [file2 ...]" >&2
  exit 1
fi

model="$1"
note_path="$2"
label="$3"
prompt="$4"
shift 4

tmp_file="$(mktemp)"
cleanup() {
  rm -f "$tmp_file"
}
trap cleanup EXIT

cmd=(opencode run -m "$model")
for f in "$@"; do
  cmd+=(-f "$f")
done
cmd+=(-- "$prompt")

perl -e 'alarm shift; exec @ARGV' 300 "${cmd[@]}" > "$tmp_file"

if [ ! -s "$tmp_file" ]; then
  echo "opencode produced empty output for $label" >&2
  exit 1
fi

{
  printf "\n\n## Second Pass - %s\n\n" "$label"
  cat "$tmp_file"
  printf "\n"
} >> "$note_path"
