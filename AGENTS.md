# AGENTS.md — BOYFINITY Hub

Project-wide instructions for AI coding agents. Keep this file short; it routes, it does not describe the design.

## Design and Frontend Work

1. **Read `DESIGN.md` first.** Before any frontend, UI, or styling work, read the root `DESIGN.md` (BOYFINITY Hub Official Design System). It is the authoritative visual specification. Do not invent visual styles for individual pages.
2. **Load and apply the `antislop` skill** for any design or frontend task. It is a quality filter and the mandatory pre-delivery gate. The core skill and its companions (`antislop-code`, `antislop-copywriting`, `antislop-ui`, `antislop-layoutmobile`, `antislop-human`) live under the agent's skills directory.
3. **Reuse existing components.** Extend and compose what the project already has instead of building parallel one-off versions.
4. **Never invent conflicting design tokens.** Use the exact color, spacing, radius, and typography tokens defined in `DESIGN.md`. No new palette entries, radii, or font stacks without approval.
5. **Avoid generic AI-generated aesthetics.** No glowing CTAs, neon purple, purple-blue gradients, decorative gradient blobs, excessive glassmorphism, floating cards, random particles, oversized pills, or nested cards. Follow the fifteen Anti-AI rules in `DESIGN.md` §3.
6. **Preserve existing functionality.** Do not remove, rename, or break working behavior, and do not touch unrelated files or content.
7. **Run relevant quality checks before completing work.** For UI work, run the AntiSlop Delivery Gate and the `DESIGN.md` Design Quality Gate, then report the PASS/FAIL evidence.

## Project Layout

- `DESIGN.md` — official design system and visual specification.
- `Boyfinity-ViolenceDistrict-Main.lua` — Roblox game client script (not a web file; do not restyle it from `DESIGN.md`).
