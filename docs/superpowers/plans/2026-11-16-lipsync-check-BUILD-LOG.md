# Build Log: lip sync check
Started 2026-11-16. MODEL=gpt-6.1-sol ultra. MAX_ROUNDS=5.

## Round 1 — Codex build
892/892, build OK.
### Round 1 — Claude review → fix-list
1. Detector used LOW resolution + MINIMAL thinking — too weak for lip articulation; make MEDIUM/MEDIUM env-configurable. 2. Detector cost used flash-lite prices; add LIPSYNC_PRICE_*. 3. Test for config.
## Round 2 — Codex fixes
900/900, build OK.
### Round 2 — Claude review
Verified fixes; re-ran 900/900 + build myself. Clean.
