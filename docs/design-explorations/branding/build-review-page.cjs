const fs = require('node:fs');
const path = require('node:path');

const contour = 'M17 108 48 31Q52 20 62 20V40L49 74Q56 68 64 68Q72 68 79 74L66 40V20Q76 20 80 31L111 108H89L85 96Q80 83 64 83Q48 83 43 96L39 108Z';
const markSvg = (fill = 'currentColor', size = 52) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${size}" height="${size}" role="img" aria-label="Ambio open arch">
  <path fill="${fill}" d="${contour}"/>
</svg>
`;

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ambio — Brand Applications Review (02 / Open Arch)</title>
  <style>
    @font-face {
      font-family: 'Plex';
      src: url('../../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2');
      font-weight: 400;
    }
    @font-face {
      font-family: 'Plex';
      src: url('../../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2');
      font-weight: 500;
    }
    @font-face {
      font-family: 'Plex';
      src: url('../../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2');
      font-weight: 600;
    }
    @font-face {
      font-family: 'JetBrains';
      src: url('../../../node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2');
      font-weight: 400;
    }
    @font-face {
      font-family: 'JetBrains';
      src: url('../../../node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2');
      font-weight: 500;
    }

    :root {
      --teal: #244b45;
      --teal-deep: #162a26;
      --ivory: #f5f3ed;
      --parchment: #e8ebe3;
      --parchment-border: #ccd4ca;
      --text-muted: #62736a;
      --font-ui: 'Plex', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      --font-mono: 'JetBrains', monospace;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--ivory);
      color: var(--teal);
      font-family: var(--font-ui);
      line-height: 1.5;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 40px 48px;
    }

    /* Top Masthead */
    .masthead {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--parchment-border);
      margin-bottom: 36px;
    }
    .masthead-title {
      font-size: 26px;
      font-weight: 600;
      letter-spacing: -0.8px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .masthead-badge {
      font-size: 11px;
      letter-spacing: 1.4px;
      text-transform: uppercase;
      color: var(--text-muted);
      font-weight: 500;
    }

    /* Section Structure */
    .section-review {
      margin-bottom: 56px;
      padding-bottom: 48px;
      border-bottom: 1px solid var(--parchment-border);
    }
    .section-review:last-child {
      border-bottom: none;
      margin-bottom: 0;
    }
    .section-header {
      margin-bottom: 24px;
    }
    .section-eyebrow {
      font-size: 11px;
      letter-spacing: 1.6px;
      text-transform: uppercase;
      color: var(--text-muted);
      font-weight: 600;
      margin-bottom: 4px;
    }
    .section-title {
      font-size: 28px;
      font-weight: 500;
      letter-spacing: -0.6px;
      margin: 0 0 8px;
    }
    .section-desc {
      font-size: 14px;
      color: var(--text-muted);
      margin: 0;
      max-width: 800px;
    }

    /* Cards & Panels */
    .panel-grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
    }
    .panel-grid-3 {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 20px;
    }
    .panel-card {
      background: var(--parchment);
      border-radius: 12px;
      padding: 24px;
      border: 1px solid rgba(36, 75, 69, 0.08);
    }
    .panel-card.dark {
      background: var(--teal);
      color: var(--ivory);
      border: 1px solid rgba(245, 243, 237, 0.12);
    }
    .card-label {
      font-size: 11px;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      font-weight: 600;
      opacity: 0.7;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
    }

    /* 1. TYPOGRAPHY STUDIES */
    .type-study-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      background: #fbfbf9;
      border-radius: 8px;
      margin-bottom: 12px;
      border: 1px solid rgba(36, 75, 69, 0.06);
    }
    .type-study-row.dark {
      background: rgba(22, 42, 38, 0.6);
      border-color: rgba(245, 243, 237, 0.08);
    }
    .type-meta {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.4;
    }
    .type-meta strong {
      color: var(--teal);
      display: block;
      font-size: 13px;
    }
    .dark .type-meta strong {
      color: var(--ivory);
    }

    /* Lockup demonstrations */
    .lockup-demo {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .lockup-text-lower-med {
      font-size: 42px;
      font-weight: 500;
      letter-spacing: -1.5px;
    }
    .lockup-text-title-med {
      font-size: 42px;
      font-weight: 500;
      letter-spacing: -1.2px;
    }
    .lockup-text-title-semi {
      font-size: 42px;
      font-weight: 600;
      letter-spacing: -1.2px;
    }
    .lockup-text-mono {
      font-family: var(--font-mono);
      font-size: 38px;
      font-weight: 500;
      letter-spacing: -1.5px;
    }

    /* Spacing calibration guide */
    .spacing-ruler-box {
      background: #ffffff;
      border-radius: 8px;
      padding: 24px;
      position: relative;
      margin-top: 16px;
      border: 1px solid #d8ddd5;
    }
    .spacing-ruler-box.dark {
      background: #19332f;
      border-color: #2b5750;
    }
    .datum-line {
      position: absolute;
      left: 0;
      right: 0;
      height: 1px;
      background: rgba(200, 50, 50, 0.4);
      pointer-events: none;
    }
    .datum-label {
      position: absolute;
      right: 8px;
      font-size: 9px;
      font-family: var(--font-mono);
      color: rgba(200, 50, 50, 0.8);
      top: -12px;
    }

    /* 2. TOOLBAR APPLICATIONS */
    .mock-window {
      background: #182321;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 16px 40px rgba(0,0,0,0.22);
      border: 1px solid rgba(255,255,255,0.08);
      margin-bottom: 24px;
    }
    .mock-window.light {
      background: #f7f6f2;
      border: 1px solid #ccd4ca;
      box-shadow: 0 16px 40px rgba(36,75,69,0.08);
    }
    .mock-titlebar {
      height: 38px;
      display: flex;
      align-items: center;
      padding: 0 14px;
      background: #141c1a;
      border-bottom: 1px solid rgba(255,255,255,0.07);
      color: #e4ece7;
      font-size: 12px;
      gap: 12px;
    }
    .mock-window.light .mock-titlebar {
      background: #edebe4;
      border-bottom: 1px solid #d4dad1;
      color: #244b45;
    }
    .mock-menu-items {
      display: flex;
      gap: 14px;
      font-size: 11px;
      color: #92a8a1;
      font-weight: 400;
    }
    .mock-window.light .mock-menu-items {
      color: #637a72;
    }
    .mock-window-title {
      font-weight: 600;
      font-size: 11px;
      letter-spacing: 0.2px;
      margin-left: 4px;
    }
    .mock-status-pill {
      margin-left: auto;
      font-size: 10px;
      font-family: var(--font-mono);
      letter-spacing: 0.6px;
      background: rgba(142, 208, 193, 0.12);
      color: #9fe2d4;
      padding: 2px 8px;
      border-radius: 4px;
      border: 1px solid rgba(142, 208, 193, 0.2);
    }
    .mock-window.light .mock-status-pill {
      background: rgba(36, 75, 69, 0.08);
      color: #244b45;
      border-color: rgba(36, 75, 69, 0.16);
    }
    .mock-window-dots {
      display: flex;
      gap: 6px;
      margin-left: 12px;
    }
    .mock-window-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: rgba(255,255,255,0.2);
    }
    .mock-window.light .mock-window-dot {
      background: rgba(0,0,0,0.18);
    }
    .mock-commandbar {
      height: 44px;
      display: flex;
      align-items: center;
      padding: 0 14px;
      background: #192421;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      gap: 8px;
    }
    .mock-window.light .mock-commandbar {
      background: #f4f3ed;
      border-bottom: 1px solid #d8dfd5;
    }
    .mock-cmd-btn {
      height: 28px;
      padding: 0 10px;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      border-radius: 4px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      color: #d1ded8;
    }
    .mock-window.light .mock-cmd-btn {
      background: #e8ece5;
      border: 1px solid #ccd5c9;
      color: #244b45;
    }
    .mock-surface-badge {
      font-size: 11px;
      margin-left: 12px;
      display: flex;
      flex-direction: column;
      line-height: 1.1;
    }
    .mock-surface-badge span { font-size: 9px; color: #829a92; text-transform: uppercase; }
    .mock-surface-badge strong { color: #e4ece7; font-weight: 600; }
    .mock-window.light .mock-surface-badge strong { color: #244b45; }

    /* 3. APP ICON APPLICATIONS */
    .icon-showcase {
      display: flex;
      align-items: center;
      justify-content: space-around;
      padding: 32px 0;
    }
    .macos-squircle {
      width: 160px;
      height: 160px;
      border-radius: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      box-shadow: 0 20px 40px rgba(0,0,0,0.28), 0 2px 6px rgba(0,0,0,0.12);
      transition: transform 0.2s;
    }
    .macos-squircle.light {
      background: linear-gradient(180deg, #faf9f5 0%, #edeae0 100%);
      border: 1px solid rgba(255,255,255,0.8);
    }
    .macos-squircle.dark {
      background: linear-gradient(180deg, #2a5851 0%, #1a3833 100%);
      border: 1px solid rgba(255,255,255,0.14);
    }
    .icon-sizes-strip {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      padding-top: 24px;
      border-top: 1px solid rgba(36, 75, 69, 0.1);
    }
    .dark .icon-sizes-strip {
      border-color: rgba(245, 243, 237, 0.14);
    }
    .dock-preview {
      background: rgba(255, 255, 255, 0.35);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.45);
      border-radius: 20px;
      padding: 10px 18px;
      display: inline-flex;
      gap: 16px;
      align-items: center;
      margin-top: 20px;
      box-shadow: 0 16px 36px rgba(0,0,0,0.15);
    }
    .dock-item {
      width: 48px;
      height: 48px;
      border-radius: 11px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 600;
      box-shadow: 0 4px 8px rgba(0,0,0,0.12);
    }
    .dock-finder { background: linear-gradient(180deg, #4aa6ec, #1c74d6); color: white; }
    .dock-terminal { background: #1c2128; color: #4ade80; font-family: var(--font-mono); }
    .dock-vscode { background: #007acc; color: white; }

    /* 4. SPLASH SCREEN / LAUNCHER APPLICATION */
    .launcher-frame {
      background: var(--ivory);
      border: 1px solid var(--parchment-border);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 24px 60px rgba(36,75,69,0.1);
    }
    .launcher-titlebar {
      height: 38px;
      background: #ede9df;
      border-bottom: 1px solid #dcd7cb;
      padding: 0 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      font-weight: 500;
      color: #3b5f58;
    }
    .launcher-body {
      display: grid;
      grid-template-columns: 460px 1fr;
      min-height: 480px;
    }
    .launcher-intro {
      padding: 40px;
      border-right: 1px solid var(--parchment-border);
      background: #fbfaf6;
    }
    .launcher-deck {
      padding: 40px;
      background: #f4f2ea;
    }
    .launcher-eyebrow {
      font-size: 10px;
      letter-spacing: 1.6px;
      font-weight: 600;
      color: #6d847c;
      text-transform: uppercase;
      margin-bottom: 18px;
    }
    .launcher-hero-mark {
      margin-bottom: 16px;
    }
    .launcher-h1 {
      font-size: 40px;
      font-weight: 500;
      letter-spacing: -1.2px;
      margin: 0 0 12px;
      color: var(--teal);
    }
    .launcher-statement {
      font-size: 17px;
      line-height: 1.4;
      font-weight: 400;
      color: #2e5952;
      margin-bottom: 14px;
    }
    .launcher-desc {
      font-size: 13px;
      line-height: 1.6;
      color: var(--text-muted);
      margin-bottom: 28px;
    }
    .capability-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .capability-item {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
      font-size: 12px;
    }
    .capability-num {
      font-family: var(--font-mono);
      font-size: 10px;
      color: #79948c;
      font-weight: 600;
      margin-top: 1px;
    }
    .capability-item strong {
      display: block;
      color: var(--teal);
      font-size: 12px;
    }
    .capability-item p {
      margin: 2px 0 0;
      color: var(--text-muted);
      font-size: 11px;
      line-height: 1.4;
    }

    /* Mock Deck Projects */
    .deck-heading {
      font-size: 18px;
      font-weight: 500;
      margin: 0 0 4px;
      color: var(--teal);
    }
    .deck-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin: 0 0 20px;
    }
    .deck-card {
      background: white;
      border: 1px solid #dbe2d9;
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .deck-card strong {
      display: block;
      font-size: 14px;
      color: var(--teal);
    }
    .deck-card span {
      font-size: 11px;
      color: var(--text-muted);
    }
    .deck-tag {
      font-family: var(--font-mono);
      font-size: 10px;
      background: rgba(36,75,69,0.08);
      color: var(--teal);
      padding: 3px 8px;
      border-radius: 4px;
    }
  </style>
</head>
<body>

<div class="container">

  <!-- MASTHEAD -->
  <header class="masthead">
    <div class="masthead-title">
      ${markSvg('#244b45', 30)}
      <span>ambio / brand review</span>
    </div>
    <div class="masthead-badge">
      Direction 02 / Open Arch · Applications Review
    </div>
  </header>

  <!-- SECTION 1: WORDMARK & LOCKUP STUDIES -->
  <section id="section-wordmark" class="section-review">
    <div class="section-header">
      <div class="section-eyebrow">Part 1 · Typography & Optical Lockup</div>
      <h2 class="section-title">Wordmark Studies & Proportions</h2>
      <p class="section-desc">
        The Open Arch mark is authoritative and structural. The wordmark study in IBM Plex Sans Medium is evaluated below against title-case, semi-bold, and monospace pairings with optical baseline and kerning calibrations.
      </p>
    </div>

    <div class="panel-grid-2">
      <!-- Light Panel Studies -->
      <div class="panel-card">
        <div class="card-label">
          <span>Light Background (#f5f3ed)</span>
          <span>Solid Teal (#244b45)</span>
        </div>

        <!-- Study 1: Lowercase Medium (Current Study) -->
        <div class="type-study-row">
          <div class="lockup-demo">
            ${markSvg('#244b45', 44)}
            <span class="lockup-text-lower-med" style="color: #244b45;">ambio</span>
          </div>
          <div class="type-meta">
            <strong>Study A · Lowercase Medium</strong>
            IBM Plex Sans 500 · Tracking: -0.03em
          </div>
        </div>

        <!-- Study 2: Titlecase Medium -->
        <div class="type-study-row">
          <div class="lockup-demo">
            ${markSvg('#244b45', 44)}
            <span class="lockup-text-title-med" style="color: #244b45;">Ambio</span>
          </div>
          <div class="type-meta">
            <strong>Study B · Titlecase Medium</strong>
            Capital 'A' mirrors mark's verticality
          </div>
        </div>

        <!-- Study 3: Titlecase SemiBold -->
        <div class="type-study-row">
          <div class="lockup-demo">
            ${markSvg('#244b45', 44)}
            <span class="lockup-text-title-semi" style="color: #244b45;">Ambio</span>
          </div>
          <div class="type-meta">
            <strong>Study C · Titlecase SemiBold</strong>
            IBM Plex Sans 600 · Balances heavy pillars
          </div>
        </div>

        <!-- Study 4: JetBrains Mono Technical -->
        <div class="type-study-row">
          <div class="lockup-demo">
            ${markSvg('#244b45', 40)}
            <span class="lockup-text-mono" style="color: #244b45;">ambio</span>
          </div>
          <div class="type-meta">
            <strong>Study D · Monospace Developer</strong>
            JetBrains Mono 500 · Code-native identity
          </div>
        </div>
      </div>

      <!-- Dark Panel Studies -->
      <div class="panel-card dark">
        <div class="card-label">
          <span>Dark Background (#244b45)</span>
          <span>Reversed Ivory (#f5f3ed)</span>
        </div>

        <!-- Study 1 Dark -->
        <div class="type-study-row dark">
          <div class="lockup-demo">
            ${markSvg('#f5f3ed', 44)}
            <span class="lockup-text-lower-med" style="color: #f5f3ed;">ambio</span>
          </div>
          <div class="type-meta">
            <strong>Study A · Lowercase Medium</strong>
            IBM Plex Sans 500 · Reversed
          </div>
        </div>

        <!-- Study 2 Dark -->
        <div class="type-study-row dark">
          <div class="lockup-demo">
            ${markSvg('#f5f3ed', 44)}
            <span class="lockup-text-title-med" style="color: #f5f3ed;">Ambio</span>
          </div>
          <div class="type-meta">
            <strong>Study B · Titlecase Medium</strong>
            Plex Sans 500 · Reversed
          </div>
        </div>

        <!-- Study 3 Dark -->
        <div class="type-study-row dark">
          <div class="lockup-demo">
            ${markSvg('#f5f3ed', 44)}
            <span class="lockup-text-title-semi" style="color: #f5f3ed;">Ambio</span>
          </div>
          <div class="type-meta">
            <strong>Study C · Titlecase SemiBold</strong>
            Plex Sans 600 · Reversed
          </div>
        </div>

        <!-- Study 4 Dark -->
        <div class="type-study-row dark">
          <div class="lockup-demo">
            ${markSvg('#f5f3ed', 40)}
            <span class="lockup-text-mono" style="color: #f5f3ed;">ambio</span>
          </div>
          <div class="type-meta">
            <strong>Study D · Monospace Developer</strong>
            JetBrains Mono 500 · Reversed
          </div>
        </div>
      </div>
    </div>

    <!-- Spacing & Optical Alignment Calibration -->
    <div class="spacing-ruler-box" style="margin-top: 24px;">
      <div class="card-label">
        <span>Optical Alignment & Proportional Spacing (Study B Lockup)</span>
        <span>Mark Height: 48px · Gap: 16px · Cap Height: 33px · Baseline Aligned</span>
      </div>
      <div style="display: flex; align-items: baseline; gap: 16px; padding: 20px 0; position: relative;">
        <!-- Baseline reference line -->
        <div style="position: absolute; bottom: 25px; left: 0; right: 0; height: 1px; background: rgba(220, 60, 60, 0.35);"></div>
        <!-- Cap-height reference line -->
        <div style="position: absolute; bottom: 58px; left: 0; right: 0; height: 1px; background: rgba(60, 120, 220, 0.35);"></div>
        
        <div style="display: flex; align-items: flex-end;">
          ${markSvg('#244b45', 48)}
        </div>
        <span style="font-size: 44px; font-weight: 500; letter-spacing: -1.2px; color: #244b45; line-height: 1;">Ambio</span>
        <span style="font-size: 13px; color: var(--text-muted); margin-left: 24px; font-family: var(--font-mono);">
          Red: Baseline (y=108) · Blue: Cap-Height / Bridge Level (y=68)
        </span>
      </div>
    </div>
  </section>


  <!-- SECTION 2: TOOLBAR APPLICATIONS -->
  <section id="section-toolbar" class="section-review">
    <div class="section-header">
      <div class="section-eyebrow">Part 2 · In-App Integration</div>
      <h2 class="section-title">Ambio Workbench Toolbar & Titlebar</h2>
      <p class="section-desc">
        Testing Open Arch at microscopic titlebar scales (18px and 20px). The split crown and curved bridge remain distinctly recognizable even at 18px without fill clogging or blur.
      </p>
    </div>

    <!-- Dark Toolbar Mockup (Production Default) -->
    <div class="mock-window">
      <div class="mock-titlebar">
        <div style="display: flex; align-items: center; gap: 8px;">
          ${markSvg('#f5f3ed', 18)}
          <span class="mock-window-title">Ambio</span>
        </div>
        <div class="mock-menu-items">
          <span>File</span>
          <span>Edit</span>
          <span>View</span>
          <span>Map</span>
          <span>Tools</span>
          <span>Window</span>
          <span>Help</span>
        </div>
        <span style="margin-left: 12px; color: #789088; font-size: 11px;">— Architecture Workbench</span>
        <div class="mock-status-pill">INDEX CLEAN</div>
        <div class="mock-window-dots">
          <div class="mock-window-dot"></div>
          <div class="mock-window-dot"></div>
          <div class="mock-window-dot"></div>
        </div>
      </div>
      <div class="mock-commandbar">
        <div class="mock-cmd-btn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 3"/></svg>
          Lasso Select
        </div>
        <div class="mock-cmd-btn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/></svg>
          Agent Log
        </div>
        <div class="mock-surface-badge">
          <span>SURFACE</span>
          <strong>The Floor (Live Graph)</strong>
        </div>
        <div style="margin-left: auto; display: flex; gap: 8px;">
          <div class="mock-cmd-btn">Search ⌘K</div>
          <div class="mock-cmd-btn" style="background: rgba(142, 208, 193, 0.15); border-color: rgba(142, 208, 193, 0.3); color: #9fe2d4;">Message Agent</div>
        </div>
      </div>
    </div>

    <!-- Light Toolbar Mockup -->
    <div class="mock-window light">
      <div class="mock-titlebar">
        <div style="display: flex; align-items: center; gap: 8px;">
          ${markSvg('#244b45', 18)}
          <span class="mock-window-title" style="color: #244b45;">Ambio</span>
        </div>
        <div class="mock-menu-items">
          <span>File</span>
          <span>Edit</span>
          <span>View</span>
          <span>Map</span>
          <span>Tools</span>
          <span>Window</span>
          <span>Help</span>
        </div>
        <span style="margin-left: 12px; color: #768d85; font-size: 11px;">— Architecture Workbench</span>
        <div class="mock-status-pill">INDEX CLEAN</div>
        <div class="mock-window-dots">
          <div class="mock-window-dot"></div>
          <div class="mock-window-dot"></div>
          <div class="mock-window-dot"></div>
        </div>
      </div>
      <div class="mock-commandbar">
        <div class="mock-cmd-btn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 3"/></svg>
          Lasso Select
        </div>
        <div class="mock-cmd-btn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/></svg>
          Agent Log
        </div>
        <div class="mock-surface-badge">
          <span>SURFACE</span>
          <strong>The Floor (Live Graph)</strong>
        </div>
        <div style="margin-left: auto; display: flex; gap: 8px;">
          <div class="mock-cmd-btn">Search ⌘K</div>
          <div class="mock-cmd-btn" style="background: rgba(36, 75, 69, 0.08); border-color: rgba(36, 75, 69, 0.2); color: #244b45; font-weight: 500;">Message Agent</div>
        </div>
      </div>
    </div>
  </section>


  <!-- SECTION 3: APP ICON APPLICATIONS -->
  <section id="section-appicon" class="section-review">
    <div class="section-header">
      <div class="section-eyebrow">Part 3 · Desktop OS Presence</div>
      <h2 class="section-title">App Icon Container (macOS & Windows)</h2>
      <p class="section-desc">
        Testing the Open Arch silhouette in native app icon containers: Primary Ivory Canvas vs. Reversed Deep Teal Canvas.
      </p>
    </div>

    <div class="panel-grid-2">
      <!-- Ivory Canvas App Icon -->
      <div class="panel-card" style="text-align: center;">
        <div class="card-label">
          <span>Icon Variant 1 (Primary / Ivory Canvas)</span>
          <span>Solid Teal on Warm Linen</span>
        </div>
        <div class="icon-showcase">
          <div class="macos-squircle light">
            ${markSvg('#244b45', 96)}
          </div>
        </div>
        <div class="icon-sizes-strip">
          <div><div style="width:16px;height:16px;">${markSvg('#244b45', 16)}</div><small>16px</small></div>
          <div><div style="width:24px;height:24px;">${markSvg('#244b45', 24)}</div><small>24px</small></div>
          <div><div style="width:32px;height:32px;">${markSvg('#244b45', 32)}</div><small>32px</small></div>
          <div><div style="width:48px;height:48px;">${markSvg('#244b45', 48)}</div><small>48px</small></div>
          <div><div style="width:64px;height:64px;">${markSvg('#244b45', 64)}</div><small>64px</small></div>
        </div>
      </div>

      <!-- Teal Canvas App Icon -->
      <div class="panel-card dark" style="text-align: center;">
        <div class="card-label">
          <span>Icon Variant 2 (Reversed / Deep Teal Canvas)</span>
          <span>Reversed Ivory on Spruce/Teal</span>
        </div>
        <div class="icon-showcase">
          <div class="macos-squircle dark">
            ${markSvg('#f5f3ed', 96)}
          </div>
        </div>
        <div class="icon-sizes-strip">
          <div><div style="width:16px;height:16px;">${markSvg('#f5f3ed', 16)}</div><small>16px</small></div>
          <div><div style="width:24px;height:24px;">${markSvg('#f5f3ed', 24)}</div><small>24px</small></div>
          <div><div style="width:32px;height:32px;">${markSvg('#f5f3ed', 32)}</div><small>32px</small></div>
          <div><div style="width:48px;height:48px;">${markSvg('#f5f3ed', 48)}</div><small>48px</small></div>
          <div><div style="width:64px;height:64px;">${markSvg('#f5f3ed', 64)}</div><small>64px</small></div>
        </div>
      </div>
    </div>

    <!-- macOS Dock Context Preview -->
    <div style="text-align: center; margin-top: 24px;">
      <div style="font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px;">
        macOS Dock Context Simulation (Variant 1 vs 2)
      </div>
      <div class="dock-preview">
        <div class="dock-item dock-finder">Finder</div>
        <div class="dock-item dock-terminal">&gt;_</div>
        <div class="dock-item dock-vscode">Code</div>
        <!-- Ambio Dock Icon (Variant 1) -->
        <div class="dock-item" style="background: linear-gradient(180deg, #faf9f5, #edeae0); border: 1px solid rgba(255,255,255,0.8);">
          ${markSvg('#244b45', 34)}
        </div>
        <!-- Ambio Dock Icon (Variant 2) -->
        <div class="dock-item" style="background: linear-gradient(180deg, #2a5851, #1a3833); border: 1px solid rgba(255,255,255,0.15);">
          ${markSvg('#f5f3ed', 34)}
        </div>
      </div>
    </div>
  </section>


  <!-- SECTION 4: SPLASH SCREEN / LAUNCHER APPLICATION -->
  <section id="section-splash" class="section-review">
    <div class="section-header">
      <div class="section-eyebrow">Part 4 · Welcome & Onboarding</div>
      <h2 class="section-title">Project Navigator Splash Screen (HomeScreen.tsx)</h2>
      <p class="section-desc">
        How the Open Arch mark anchors the main entrance into Ambio, establishing architectural gravitas on first launch.
      </p>
    </div>

    <div class="launcher-frame">
      <div class="launcher-titlebar">
        <div style="display: flex; align-items: center; gap: 8px;">
          ${markSvg('#244b45', 16)}
          <strong>Ambio Architecture Workbench</strong>
          <span style="opacity: 0.7;">— Project Navigator</span>
        </div>
        <span style="font-family: var(--font-mono); font-size: 10px; background: rgba(36,75,69,0.08); padding: 2px 6px; border-radius: 3px;">READY</span>
      </div>

      <div class="launcher-body">
        <!-- Left: Intro & Brand -->
        <div class="launcher-intro">
          <div class="launcher-eyebrow">SPATIAL ARCHITECTURE WORKBENCH</div>
          <div class="launcher-hero-mark">
            ${markSvg('#244b45', 68)}
          </div>
          <h1 class="launcher-h1">Ambio</h1>
          <p class="launcher-statement">
            See your entire codebase.<br>
            Steer what your agents build.
          </p>
          <p class="launcher-desc">
            A live architecture canvas wired directly to your repository and AI coding agents. Explore real system topology, sketch new features as visual blueprints, and review agent changes spatially instead of reading 40-file diffs.
          </p>

          <ol class="capability-list">
            <li class="capability-item">
              <span class="capability-num">01</span>
              <div>
                <strong>Living code topology</strong>
                <p>Automatically maps system boundaries, imports, and call graphs as code changes.</p>
              </div>
            </li>
            <li class="capability-item">
              <span class="capability-num">02</span>
              <div>
                <strong>Visual agent dispatch</strong>
                <p>Sketch new components on canvas; connected MCP agents turn your design into code.</p>
              </div>
            </li>
            <li class="capability-item">
              <span class="capability-num">03</span>
              <div>
                <strong>Semantic zoom</strong>
                <p>Glide seamlessly from high-level architecture down to files, symbols, and live source.</p>
              </div>
            </li>
          </ol>
        </div>

        <!-- Right: Command Deck / Start -->
        <div class="launcher-deck">
          <div style="font-size: 11px; letter-spacing: 1.2px; text-transform: uppercase; color: var(--text-muted); font-weight: 600; margin-bottom: 4px;">START</div>
          <h2 class="deck-heading">Command Deck</h2>
          <p class="deck-sub">See what changed, what agents are doing, and what intent is still open — then enter the canvas.</p>

          <div class="deck-card">
            <div>
              <strong>Ambio Core Engine</strong>
              <span>c:/Users/maxst/VSCodeProjects/Axiom</span>
            </div>
            <div class="deck-tag">142 files · 18 systems</div>
          </div>

          <div class="deck-card">
            <div>
              <strong>Documentation & Design</strong>
              <span>docs/design-explorations/branding</span>
            </div>
            <div class="deck-tag">Open Arch Selected</div>
          </div>

          <div style="margin-top: 24px; display: flex; gap: 12px;">
            <button style="padding: 10px 18px; background: var(--teal); color: var(--ivory); border: none; border-radius: 6px; font-weight: 500; font-size: 12px; cursor: pointer;">
              Open Project Folder…
            </button>
            <button style="padding: 10px 18px; background: white; color: var(--teal); border: 1px solid #ccd4ca; border-radius: 6px; font-weight: 500; font-size: 12px; cursor: pointer;">
              New Workspace…
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>

</div>

</body>
</html>
`;

fs.writeFileSync(path.join(__dirname, 'review-applications.html'), html);
console.log('Wrote review-applications.html');

