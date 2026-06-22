# Credits

The `magister-*` leader/orchestration skills in this directory were shaped by
prior open work on agent skill systems and workflow discipline. In particular,
their structure and several conventions — progressive skill loading, the
"rationalization red-flags" framing, the verify-before-completion discipline,
and the "load the skill before you act" bootstrap pattern — are **adapted from**:

- **[obra/superpowers](https://github.com/obra/superpowers)** — MIT License,
  © Jesse Vincent and contributors. The skill-invocation bootstrap, the
  red-flags tables, and the verification/teammate-review disciplines are
  derivative of superpowers' equivalents, rewritten for Magister's
  leader/teammate orchestration model.
- General multi-agent **workflow-staging ideas** (plan → build → review → ship,
  cross-model adversarial review) drawn from the broader agent-orchestration
  community.

The skill bodies here are independently rewritten for Magister's domain (leader
loop, `spawn_teammate`, role routing), not verbatim copies, but we credit the
sources above out of respect and to satisfy the MIT attribution requirement for
derivative work.
