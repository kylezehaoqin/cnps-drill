---
description: Verify, then commit
---

1. Run `./scripts/check.sh`. If it fails, stop and report — do not commit.
2. Run `git diff --stat` and `git status` to see what changed.
3. Commit with a message that says what behaviour changed and why, not which
   files moved. If the change fixes a bug, name the symptom the user would
   have seen.
4. If the change touched an invariant listed in `CLAUDE.md`, update that
   section in the same commit.

Do not push. Do not tag.
