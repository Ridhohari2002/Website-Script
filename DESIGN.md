# BOYFINITY Hub — Design System

**Version:** 1.1
**Status:** Official Design Specification
**Design Direction:** Premium Dark Editorial / Minimalist Software
**Visual Identity:** Deep Black × Restrained Deep Purple

---

## 1. Core Design Philosophy

BOYFINITY must look like a carefully art-directed premium software product.

The interface must feel:
- Mature
- Technical
- Minimal
- Precise
- Sophisticated
- Intentional

The design must NOT look like a generic AI-generated SaaS template.

### The most important principle

**Less decoration. More design intention.**

Every visual element must have a purpose.

Use typography, spacing, alignment, contrast, proportions, and composition to create visual quality.

Do not rely on glowing effects, gradients, excessive rounded corners, or decorative cards to make the interface look premium.

---

## 2. Color System

### Background

| Token | Value | Usage |
|---|---|---|
| bg-primary | #08090B | Main background |
| bg-secondary | #0D0F13 | Secondary sections |
| bg-surface | #111318 | Cards and panels |
| bg-elevated | #171A21 | Dropdowns and overlays |
| bg-hover | #191C23 | Hover surfaces |
| bg-input | #0B0D11 | Input fields |

### Purple accent

| Token | Value | Usage |
|---|---|---|
| purple-primary | #34264D | Primary CTA |
| purple-hover | #443361 | CTA hover |
| purple-active | #281D3B | CTA active |
| purple-soft | #211A2D | Subtle selected surfaces |
| purple-border | #51406E | Selected border |
| purple-text | #C5B2E2 | Accent text |

Purple is an accent, not a dominant decoration.

Use it selectively for important actions, active navigation, and meaningful emphasis.

### Text

| Token | Value |
|---|---|
| text-primary | #F1F1F3 |
| text-secondary | #A1A4AE |
| text-muted | #858995 |
| text-disabled | #555963 |
| text-inverse | #FFFFFF |

### Borders

| Token | Value |
|---|---|
| border-default | #252832 |
| border-subtle | #1C1F26 |
| border-strong | #363B47 |
| border-focus | #78609A |

### Semantic colors

| Token | Value |
|---|---|
| success | #4CAF87 |
| warning | #D9A441 |
| danger | #D65C68 |
| info | #6E9DD1 |

Never introduce additional decorative colors without approval.

---

## 3. Strict Anti-AI Design Rules

These rules are mandatory.

The fifteen rules below are the canonical checklist. Each expands into the sections that follow.

1. No excessive glowing effects.
2. No neon purple.
3. No glowing CTA buttons.
4. No large radial glow backgrounds.
5. No generic purple-blue gradients.
6. No blurred decorative gradient blobs.
7. No excessive glassmorphism.
8. No floating decorative cards.
9. No unnecessary 3D objects.
10. No random particles or decorative circles.
11. No excessive rounded cards.
12. No oversized pill buttons.
13. No unnecessary nested cards.
14. No generic AI-generated SaaS layouts.
15. No decorative elements without functional or informational purpose.

### 3.1 No excessive glow

PROHIBITED:
- Purple glowing buttons
- Neon borders
- Glowing card outlines
- Large radial glow backgrounds
- Glowing icons
- Blurred light orbs
- Glowing text
- Permanent box-shadow effects

Default shadow: none.

A subtle shadow may only be used when required to establish actual elevation.

### 3.2 No excessive rounded corners

Use restrained geometry.

| Component | Radius |
|---|---:|
| Small buttons | 4px |
| Standard buttons | 6px |
| Inputs | 4px |
| Standard cards | 6px |
| Large panels | 8px |
| Modals | 8px |
| Dropdowns | 6px |
| Badges | 3px |
| Avatars | 50% |

Pill-shaped elements are prohibited for ordinary buttons and cards.

Only avatars, compact status indicators, or explicitly justified elements may use fully rounded shapes.

Do not use 16px, 20px, or 24px rounded corners as a default card style.

### 3.3 No generic AI gradients

PROHIBITED:
- Purple-to-blue hero gradients
- Full-screen gradient backgrounds
- Large blurred gradient blobs
- Gradient card backgrounds
- Gradient text headings
- Decorative mesh gradients
- Rainbow accent colors

Use solid surfaces as the default.

If a gradient is genuinely necessary, it must be extremely subtle and have a clear visual purpose.

### 3.4 No excessive glassmorphism

Avoid:
- Frosted glass everywhere
- Transparent floating panels
- Blurred card backgrounds
- Excessive backdrop filters

Use solid dark surfaces and thin borders.

### 3.5 No decorative filler

Do not add elements just to make the interface look futuristic.

Avoid:
- Random floating circles
- Decorative particles
- Fake code snippets
- Unnecessary terminal windows
- Random technical labels
- Excessive glowing dots
- Decorative grid backgrounds
- Unnecessary floating cards
- Random abstract 3D objects

Every element must communicate real information or serve a clear design purpose.

---

## 4. Layout and Composition

Avoid repeating the same centered layout across every section.

Use deliberate composition and editorial hierarchy.

Preferred techniques:
- Asymmetric layouts
- Strong left alignment
- Controlled whitespace
- Clear content grouping
- Restrained horizontal dividers
- Varied section proportions
- Large typography paired with compact metadata
- Intentional visual balance

Do not force every section into a three-column card grid.

Not every piece of information needs its own card.

Use plain content layouts, lists, rows, and dividers when they communicate information better.

### Desktop reference

- Design width: 1440px
- Main content maximum width: 1200px
- Header height: 72px
- Sidebar width: 240–250px
- Horizontal padding: 40px

### Spacing scale

Use a consistent 4px spacing system.

4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96px.

Do not introduce arbitrary spacing without a reason.

---

## 5. Typography

Primary: Inter or Geist.
Monospace: Geist Mono.

Typography must create the visual identity rather than decorative effects.

| Element | Size | Weight |
|---|---:|---:|
| Hero heading | 56–64px | 600–700 |
| Page heading | 36–40px | 600 |
| Section heading | 28–32px | 600 |
| Card heading | 16–18px | 600 |
| Body | 14–16px | 400 |
| Metadata | 11–12px | 400–500 |

Rules:
- Avoid excessive bold text.
- Avoid uppercase text everywhere.
- Use restrained letter spacing.
- Maintain comfortable line height.
- Use monospace for technical information only.
- Avoid unnecessary text decoration.

---

## 6. Buttons and CTAs

### Primary CTA

- Background: #34264D
- Text: #FFFFFF
- Border: #51406E
- Radius: 6px
- Height: 40–48px
- Weight: 600

Hover:
- Background: #443361
- No glow
- No neon shadow
- No excessive scaling

### Secondary CTA

- Transparent background
- Border: #363B47
- Text: #F1F1F3
- Radius: 6px

### Ghost CTA

- No prominent border
- Transparent background
- Subtle hover surface

### Button rules

- Use purple only for important actions.
- Do not make every button purple.
- Do not use oversized pill buttons.
- Avoid excessive gradients.
- Keep button dimensions consistent.
- Provide visible keyboard focus.

---

## 7. Cards and Surfaces

Cards must be functional containers, not the default layout for everything.

### Standard card

- Background: #111318
- Border: 1px solid #252832
- Radius: 6px
- Padding: 20–24px
- Shadow: none

### Interactive card

- Default border: #252832
- Hover border: #363B47
- Hover background: #141720
- Transition: 150–180ms

### Important rules

- Avoid nesting cards inside cards.
- Avoid excessive card grids.
- Do not put every heading inside a separate panel.
- Avoid floating card compositions without a clear purpose.
- Prefer horizontal rows for data-heavy interfaces.
- Use separators and whitespace instead of unnecessary containers.

---

## 8. Navigation

### Public navigation

- Deep black background.
- Thin bottom border.
- Simple wordmark.
- Restrained navigation typography.
- One important CTA.
- No excessive floating effects.

### Dashboard navigation

- Dark solid sidebar.
- Active item uses a subtle purple surface.
- No glowing active indicators.
- Consistent icon dimensions.
- Clear hierarchy between groups.

---

## 9. Form Elements

- Background: #0B0D11
- Border: #252832
- Radius: 4px
- Height: 42–44px
- Text: #F1F1F3
- Placeholder: #858995

Focus state:
- Border: #78609A
- Subtle visible focus ring.
- No glowing neon effect.

Always provide visible labels and clear validation messages.

---

## 10. Icons

Use Lucide consistently.

- Standard: 18–20px
- Small: 14–16px
- Feature: 22–24px
- Consistent stroke width.

Avoid oversized decorative icons.

Never use random emoji collections as interface decoration.

---

## 11. Motion

Motion should be almost invisible.

Allowed:
- 150–180ms hover transitions
- Subtle dropdown transitions
- Modal fade
- Small sidebar transitions
- Loading skeletons

Prohibited:
- Constant pulsing
- Glowing animations
- Floating elements
- Excessive parallax
- Bouncing buttons
- Decorative particle animations
- Unnecessary page transitions

Respect prefers-reduced-motion.

---

## 12. Landing Page Direction

The landing page must look like a premium developer-oriented product.

### Navigation
Minimal horizontal navigation.

### Hero
- Large editorial headline.
- Left-aligned text.
- Short, meaningful description.
- One deep purple CTA.
- One restrained secondary action.
- Supporting visual should communicate the actual BOYFINITY ecosystem.

Do not use generic AI-generated glowing spheres, floating glass cards, or random 3D decorations.

### Statistics
Prefer clean horizontal statistics separated by thin borders rather than four oversized rounded cards.

### Featured Scripts
Use structured script previews with real game imagery, clean metadata, and restrained borders.

### Features
Use typography, columns, and dividers. Do not turn every feature into a large rounded card.

### Pricing
Use clear pricing tables or restrained pricing panels.

### FAQ
Use minimal accordion rows with thin separators.

### Footer
Simple structured footer with clear hierarchy.

---

## 13. Dashboard Direction

The dashboard must prioritize information density and clarity.

Use:
- Compact statistics
- Structured tables
- Clean data rows
- Restrained panels
- Clear navigation
- Consistent status labels

Avoid:
- Giant rounded statistic cards
- Decorative chart backgrounds
- Unnecessary gradients
- Excessive empty space
- Decorative widgets with no functional value

Information should be easy to scan.

---

## 14. Responsive Design

Desktop:
- Full navigation.
- Balanced multi-column layouts.
- Sidebar visible.

Tablet:
- Adaptive columns.
- Reduced spacing.
- Collapsible navigation when needed.

Mobile:
- Single-column layouts when appropriate.
- Compact navigation.
- Full-width usable controls.
- Responsive tables.
- No horizontal overflow.

Do not simply shrink desktop layouts.

---

## 15. Accessibility

- Readable contrast.
- Keyboard navigation.
- Visible focus states.
- Semantic HTML.
- Accessible labels.
- Clear validation.
- Reduced motion support.
- Color must not be the only status indicator.

---

## 16. Design Quality Gate

Before completing any page, verify:

- [ ] Background follows deep black identity.
- [ ] Purple is restrained and purposeful.
- [ ] No unnecessary glow or neon.
- [ ] No generic gradient decorations.
- [ ] Cards use restrained 6px radius by default.
- [ ] No excessive pill-shaped elements.
- [ ] Layout does not rely entirely on cards.
- [ ] Typography establishes visual hierarchy.
- [ ] Spacing and alignment are intentional.
- [ ] Components are consistent.
- [ ] Interface is responsive.
- [ ] Every decoration has a purpose.
- [ ] Design does not resemble a generic AI SaaS template.

---

## 17. Page Consistency

This design system applies uniformly to every surface of the product. All of the following must share the same design tokens and component conventions:

- Landing Page
- Authentication
- User Dashboard
- Admin Dashboard
- Game Scripts
- Key Management
- Pricing
- Documentation

No page may introduce its own palette, radius scale, typography, or component style.

---

## 18. Final Directive

This document is the authoritative visual specification for BOYFINITY Hub.

All public pages, authentication screens, dashboards, admin tools, and documentation interfaces must follow this system.

Do not invent new visual styles for individual pages.

Do not add trendy UI effects merely because they are common in AI-generated designs.

When uncertain, choose:
- Solid over gradient.
- Border over glow.
- Sharp geometry over excessive rounding.
- Typography over decoration.
- Whitespace over filler.
- Structured rows over unnecessary cards.
- Purposeful composition over generic templates.

**BOYFINITY Hub — Quietly powerful. Precisely designed.**
