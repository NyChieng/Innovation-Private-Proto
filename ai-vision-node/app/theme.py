"""FloraScan look for the FloraGuard camera app: the web app's design tokens
(FloraScan-Web-App/src/styles/theme.css) as a Gradio theme, plus the brand header,
stage badge and alert banner. Light or dark follows the device, as in the web app.

    demo.launch(**theme.LAUNCH)
"""
from html import escape
from pathlib import Path

import gradio as gr

MARK_FILE = Path(__file__).resolve().parent / "static" / "floraguard-mark.svg"
MARK = MARK_FILE.read_text(encoding="utf-8")  # the FloraScan mark (public/icons/mark.svg)

# FloraScan tokens: light, dark
L = dict(bg="#f1f6ef", sunk="#e3eddf", surface="#fcfdf9", surface2="#f5f8f1", surface3="#e8f0e3",
         border="#cbd8c8", strong="#9fb49e", text="#1c3427", soft="#536b59", accent="#2f6845",
         hover="#215334", on_accent="#ffffff", accent_soft="#e3eddf", danger_bg="#fdeceb",
         danger_fg="#a22f28", danger_br="#f3c9c5", input="#fcfdf9")
D = dict(bg="#0e140f", sunk="#090d0a", surface="#151d17", surface2="#1a231c", surface3="#212b23",
         border="#27332a", strong="#35443a", text="#e8eee7", soft="#b3bfb2", accent="#8fc096",
         hover="#bcdabf", on_accent="#06120b", accent_soft="#16261b", danger_bg="#2d1917",
         danger_fg="#f0a29b", danger_br="#4f2924", input="#111a13")

FOREST = gr.themes.Color(c50="#f1f7f1", c100="#dcecdd", c200="#bcdabf", c300="#8fc096", c400="#5da069",
                         c500="#3c8350", c600="#2a6840", c700="#215334", c800="#1c422b", c900="#142e1f",
                         c950="#0b1a12", name="forest")
SAGE = gr.themes.Color(c50="#f5f8f1", c100="#e8f0e3", c200="#cbd8c8", c300="#9fb49e", c400="#7d8f7c",
                       c500="#536b59", c600="#3f5446", c700="#27332a", c800="#1a231c", c900="#151d17",
                       c950="#0e140f", name="sage")
FONT = ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"]
MONO = ["ui-monospace", "SFMono-Regular", "Cascadia Mono", "Menlo", "Consolas", "monospace"]


def _pair(**names):
    """{gradio variable: token name} -> the light and _dark settings from L and D (a few variables,
    such as color_accent, have no _dark twin: Gradio derives it)."""
    base, out = gr.themes.Base(), {}
    for var, tok in names.items():
        out[var] = L[tok]
        if hasattr(base, var + "_dark"):
            out[var + "_dark"] = D[tok]
    return out


THEME = gr.themes.Base(primary_hue=FOREST, secondary_hue=FOREST, neutral_hue=SAGE, font=FONT, font_mono=MONO,
                       radius_size=gr.themes.sizes.radius_md).set(
    **_pair(body_background_fill="bg", body_text_color="text", body_text_color_subdued="soft",
            background_fill_primary="surface", background_fill_secondary="surface2",
            border_color_primary="border", block_background_fill="surface", block_border_color="border",
            block_label_background_fill="surface3", block_label_border_color="border",
            block_title_text_color="text", panel_background_fill="surface2", panel_border_color="border",
            accordion_text_color="text", color_accent="accent", color_accent_soft="accent_soft",
            link_text_color="accent", loader_color="accent", slider_color="accent",
            button_primary_background_fill="accent", button_primary_background_fill_hover="hover",
            button_primary_text_color="on_accent",
            button_secondary_background_fill="surface", button_secondary_background_fill_hover="surface3",
            button_secondary_text_color="text", button_secondary_border_color="strong",
            button_cancel_background_fill="danger_bg", button_cancel_text_color="danger_fg",
            button_cancel_border_color="danger_br",
            input_background_fill="input", input_border_color="border", input_border_color_focus="accent",
            checkbox_background_color_selected="accent", checkbox_border_color_selected="accent",
            table_even_background_fill="surface", table_odd_background_fill="surface2",
            table_border_color="border", table_text_color="text"),
    block_label_text_color=FOREST.c700, block_label_text_color_dark=FOREST.c300,
    button_primary_border_color="transparent", button_primary_border_color_dark="transparent",
    button_cancel_background_fill_hover="#f8dcd9", button_cancel_background_fill_hover_dark="#3a201d",
    block_border_width="1px", block_radius="13px", table_radius="9px",
    block_shadow="0 1px 2px rgba(20,30,20,.05), 0 1px 3px rgba(20,30,20,.05)",
    block_shadow_dark="0 1px 2px rgba(0,0,0,.4)",
    button_primary_shadow="0 1px 2px rgba(20,30,20,.08)",
    button_large_radius="9px", button_medium_radius="9px", button_small_radius="6px",
    button_large_text_weight="600", button_medium_text_weight="600",
    block_title_text_weight="600", block_label_text_weight="600",
)

CSS = """
:root { --fg-ok-bg:#e7f4ea; --fg-ok-fg:#1f6b39; --fg-ok-br:#b9dfc4;
        --fg-warn-bg:#fdf1dc; --fg-warn-fg:#8a5a10; --fg-warn-br:#f0d7a8;
        --fg-danger-bg:#fdeceb; --fg-danger-fg:#a22f28; --fg-danger-br:#f3c9c5;
        --fg-neutral-bg:#eeece6; --fg-neutral-fg:#5b6155; --fg-neutral-br:#dcd9cf;
        --fg-header-bg:#e3eddf; --fg-header-br:#9fb49e; --fg-soft:#536b59; }
.dark { --fg-ok-bg:#12291a; --fg-ok-fg:#86cca0; --fg-ok-br:#23492f;
        --fg-warn-bg:#2c2312; --fg-warn-fg:#e3bc6a; --fg-warn-br:#4c3d1c;
        --fg-danger-bg:#2d1917; --fg-danger-fg:#f0a29b; --fg-danger-br:#4f2924;
        --fg-neutral-bg:#1d251f; --fg-neutral-fg:#a3ada1; --fg-neutral-br:#2e3a30;
        --fg-header-bg:#111a13; --fg-header-br:#35443a; --fg-soft:#b3bfb2;
        --color-accent:#8fc096 !important; }  /* Gradio has no color_accent_dark */
.gradio-container { max-width: 1320px !important; }
footer { display: none !important; }

/* brand header, as the FloraScan top bar */
.fg-header { display:flex; align-items:center; gap:16px; flex-wrap:wrap; padding:14px 18px;
             background:var(--fg-header-bg); border:1px solid var(--fg-header-br); border-radius:13px; }
.fg-brand { display:flex; align-items:center; gap:12px; margin-right:auto; }
.fg-mark { width:42px; height:42px; border-radius:11px; flex:none; display:grid; place-items:center;
           background:linear-gradient(150deg,#3c8350,#1c422b); box-shadow:0 1px 3px rgba(20,30,20,.18); }
.fg-mark svg { width:34px; height:34px; }
.fg-name { font-size:1.35rem; font-weight:700; letter-spacing:-0.02em; line-height:1.1; color:var(--body-text-color); }
.fg-sub { font-size:.72rem; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--fg-soft); }
.fg-chips { display:flex; gap:8px; flex-wrap:wrap; }
.fg-chip { display:inline-flex; align-items:center; gap:7px; padding:5px 12px; border-radius:999px;
           font-size:.82rem; font-weight:600; border:1px solid; white-space:nowrap; }
.fg-chip::before { content:""; width:7px; height:7px; border-radius:50%; background:currentColor; }
.fg-models { width:100%; font-family:var(--font-mono); font-size:.74rem; color:var(--fg-soft); }
.fg-ok { background:var(--fg-ok-bg); color:var(--fg-ok-fg); border-color:var(--fg-ok-br); }
.fg-warn { background:var(--fg-warn-bg); color:var(--fg-warn-fg); border-color:var(--fg-warn-br); }
.fg-danger { background:var(--fg-danger-bg); color:var(--fg-danger-fg); border-color:var(--fg-danger-br); }
.fg-neutral { background:var(--fg-neutral-bg); color:var(--fg-neutral-fg); border-color:var(--fg-neutral-br); }

/* SAFE / WARNING / ALERT, as the web app's status badges */
.fg-stage { display:inline-flex; align-items:center; gap:9px; padding:7px 16px; border-radius:999px;
            border:1px solid; font-size:1.05rem; font-weight:700; letter-spacing:.05em; margin-bottom:6px; }
.fg-stage::before { content:""; width:10px; height:10px; border-radius:50%; background:currentColor; }
.fg-banner { display:flex; align-items:center; gap:10px; padding:12px 16px; border-radius:13px; border:1px solid;
             font-weight:600; font-size:1rem; }
.fg-banner b { letter-spacing:.04em; }
.fg-banner:empty { display:none; }

/* live stats: a quiet two-column list, as the web app's detail rows (the table has no header) */
#fg-status table { border-collapse:collapse; width:100%; border:none !important; box-shadow:none !important; }
#fg-status thead { display:none; }
#fg-status td { border:none !important; border-bottom:1px solid var(--border-color-primary) !important;
                padding:7px 10px; background:transparent !important; }
#fg-status tr:last-child td { border-bottom:none !important; }
#fg-status td:first-child { color:var(--fg-soft); width:46%; }

/* tabs and buttons in the FloraScan accent */
button[role="tab"][aria-selected="true"] { color: var(--color-accent) !important; }
button[role="tab"][aria-selected="true"]::after { background: var(--color-accent) !important; }
"""

LAUNCH = {"theme": THEME, "css": CSS, "favicon_path": str(MARK_FILE)}

_TONE = {"SAFE": "fg-ok", "WARNING": "fg-warn", "ALERT": "fg-danger", "AFTER-HOURS": "fg-danger"}


def header_html(alerts, alerts_on, zone_needed, models):
    chips = [f'<span class="fg-chip {"fg-ok" if alerts_on else "fg-neutral"}">Alerts to rangers: {escape(alerts)}</span>']
    if zone_needed:
        chips.append('<span class="fg-chip fg-warn">Plant zone: draw it once in the Plant zone tab</span>')
    return (f'<div class="fg-header"><div class="fg-brand"><span class="fg-mark">{MARK}</span><div>'
            f'<div class="fg-name">FloraGuard</div><div class="fg-sub">FloraScan AI camera · live plant protection</div>'
            f'</div></div><div class="fg-chips">{"".join(chips)}</div>'
            f'<div class="fg-models">{escape(models)}</div></div>')


def stage_html(stage):
    return f'<span class="fg-stage {_TONE.get(stage, "fg-neutral")}">{escape(stage)}</span>'


def banner_html(tier, text):
    return f'<div class="fg-banner {_TONE.get(tier, "fg-neutral")}"><b>{escape(tier)}</b> {escape(text)}</div>'
