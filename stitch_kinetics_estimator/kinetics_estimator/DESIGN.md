---
name: Kinetics Estimator
colors:
  surface: '#f9f9ff'
  surface-dim: '#d3daef'
  surface-bright: '#f9f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f1f3ff'
  surface-container: '#e9edff'
  surface-container-high: '#e1e8fd'
  surface-container-highest: '#dce2f7'
  on-surface: '#141b2b'
  on-surface-variant: '#444652'
  inverse-surface: '#293040'
  inverse-on-surface: '#edf0ff'
  outline: '#757683'
  outline-variant: '#c5c5d3'
  surface-tint: '#3f59ae'
  primary: '#002271'
  on-primary: '#ffffff'
  primary-container: '#1c398e'
  on-primary-container: '#91a8ff'
  inverse-primary: '#b6c4ff'
  secondary: '#006d31'
  on-secondary: '#ffffff'
  secondary-container: '#96f4a7'
  on-secondary-container: '#047234'
  tertiary: '#4d1a00'
  on-tertiary: '#ffffff'
  tertiary-container: '#712a00'
  on-tertiary-container: '#f89261'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dce1ff'
  primary-fixed-dim: '#b6c4ff'
  on-primary-fixed: '#001550'
  on-primary-fixed-variant: '#254095'
  secondary-fixed: '#99f7aa'
  secondary-fixed-dim: '#7dda90'
  on-secondary-fixed: '#00210a'
  on-secondary-fixed-variant: '#005323'
  tertiary-fixed: '#ffdbcc'
  tertiary-fixed-dim: '#ffb695'
  on-tertiary-fixed: '#351000'
  on-tertiary-fixed-variant: '#793005'
  background: '#f9f9ff'
  on-background: '#141b2b'
  surface-variant: '#dce2f7'
  deep-teal: '#1C398E'
  science-green: '#218242'
  warning-amber: '#D97706'
  hairline-border: '#E5E7EB'
  surface-offwhite: '#F9F9F7'
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.3'
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '400'
    lineHeight: '1.5'
  data-mono:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: '1.4'
  label-caps:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '700'
    lineHeight: '1'
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 24px
  margin: 32px
  container-max: 1200px
---

## Brand & Style

The design system for the Kinetics Estimator is built on a foundation of scientific precision, technical clarity, and academic trust. It targets a sophisticated audience of researchers and engineers who require a focused environment for complex data analysis.

The aesthetic follows a **Modern Minimalist** approach with a "Paper-to-Digital" philosophy. It borrows from the clarity of high-end scientific journals, utilizing significant white space to reduce cognitive load. The interface avoids artificial depth like shadows or gradients, relying instead on structural hairlines and intentional typographic hierarchy to create organization. The emotional response is one of calm reliability—a quiet, high-performance tool that fades into the background to let the data take center stage.

## Colors

The palette is anchored by a high-contrast foundation of **Near-Black (#111827)** text against an **Off-White (#F9F9F7)** canvas. This mimics the legibility of printed research while softening the harshness of pure white digital displays.

- **Primary (Deep Teal):** Used for primary actions, navigation states, and key data points. It conveys authority and stability.
- **Secondary (Green):** Specifically reserved for "success" states or finalized calculations, inspired by the Rowan Science palette.
- **Warning (Amber):** Used sparingly for alerts or parameter warnings.
- **Borders:** A specific light-gray hairline (#E5E7EB) is used to define structure without adding visual weight.

## Typography

The typography system is split into two functional roles: **Information Architecture** and **Data Representation**.

1.  **UI & Content:** Uses **Inter**, a geometric sans-serif known for its exceptional legibility on digital screens. Headlines use tighter tracking and heavier weights to provide clear structural anchors.
2.  **Scientific Data:** Uses **JetBrains Mono** for all numerical values, formulas, and tabular data. This ensures that decimal points align vertically in tables and that characters like '0' and 'O' are easily distinguishable, which is critical for scientific accuracy.

All typography scales down for mobile using a modular scale of 1.2, ensuring that large headlines do not break the layout on smaller viewports.

## Layout & Spacing

The design system employs a **Fixed Grid** model for desktop to maintain the "journal-like" aesthetic, centering content with generous margins. 

- **Grid:** A 12-column grid system is used with 24px gutters.
- **Rhythm:** Spacing is strictly based on a 4px baseline unit. 
- **Responsive Behavior:** 
    - **Desktop (1200px+):** Fixed container with side margins.
    - **Tablet (768px - 1199px):** Fluid width with 24px side padding; grid collapses to 8 columns.
    - **Mobile (Below 767px):** Fluid width with 16px side padding; 4-column grid; data tables should allow for horizontal scrolling to maintain mono-font legibility.

## Elevation & Depth

This design system rejects shadows in favor of **Tonal Layering** and **Hairline Outlines**. 

Depth is communicated through "Nested Containers." The base background is the off-white surface. Elements that need to appear "above" the base use a pure white background and a 1px border (#E5E7EB). Active states or hovered items are indicated by subtle shifts in background color (e.g., a very light tint of the primary teal) rather than an increase in shadow. This flat approach emphasizes the precision of the data and maintains a clean, professional look.

## Shapes

To maintain a balance between "technical" and "approachable," the system uses a **Soft (4px - 6px)** corner radius. 

- **Small elements (Buttons, Inputs):** 4px radius.
- **Large elements (Cards, Modal containers):** 6px radius.
- **Utility elements (Chips):** Fully pill-shaped to differentiate them from interactive buttons.

This subtle rounding prevents the UI from feeling "sharp" or aggressive while remaining significantly more formal than a fully rounded "consumer-grade" app.

## Components

- **Buttons:** Primary buttons use solid Deep Teal with white text. Secondary buttons use a transparent background with a 1px teal border. No shadows or gradients. 
- **Input Fields:** Use 1px hairline borders. On focus, the border transitions to Deep Teal with a subtle 1px inset ring. Labels are always positioned above the input in the `label-caps` style.
- **Data Tables:** These are the core of the app. Use `data-mono` for cells. Rows are separated by 1px hairlines. Header rows have a subtle gray background (#F3F4F6) to anchor the column names.
- **Cards:** White background, 1px border, 6px corner radius. No shadow. Used to group related parameters or calculation results.
- **Chips/Status Tags:** Used for scientific units or state indicators. They use a light background tint and a darker version of the same color for text (e.g., light teal background with deep teal text).
- **Tooltips:** Crucial for scientific definitions. These use a near-black background with white `body-sm` text, providing the only high-contrast "floating" element in the system.