#!/usr/bin/env python3
"""Render USER_GUIDE.md -> TradeAnalyzer-User-Guide.pdf using reportlab.

Source of truth is the Markdown file. Re-run this script after editing it:
    python UserManual/build_pdf.py
"""
import os
import re
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, ListFlowable, ListItem, KeepTogether,
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "USER_GUIDE.md")
OUT = os.path.join(HERE, "TradeAnalyzer-User-Guide.pdf")

# ── Fonts: prefer Arial (broad Unicode for arrows/dashes/symbols) ──────────────
FONT, FONT_B, FONT_I, FONT_BI, FONT_MONO = "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique", "Courier"
WINF = r"C:\Windows\Fonts"
try:
    pdfmetrics.registerFont(TTFont("Body", os.path.join(WINF, "arial.ttf")))
    pdfmetrics.registerFont(TTFont("Body-Bold", os.path.join(WINF, "arialbd.ttf")))
    pdfmetrics.registerFont(TTFont("Body-Italic", os.path.join(WINF, "ariali.ttf")))
    pdfmetrics.registerFont(TTFont("Body-BoldItalic", os.path.join(WINF, "arialbi.ttf")))
    pdfmetrics.registerFontFamily("Body", normal="Body", bold="Body-Bold", italic="Body-Italic", boldItalic="Body-BoldItalic")
    FONT, FONT_B, FONT_I, FONT_BI = "Body", "Body-Bold", "Body-Italic", "Body-BoldItalic"
    try:
        pdfmetrics.registerFont(TTFont("Mono", os.path.join(WINF, "consola.ttf")))
        FONT_MONO = "Mono"
    except Exception:
        pass
except Exception:
    pass  # fall back to Helvetica

# ── Strip pictographic emoji (no color-glyph rendering in reportlab) ───────────
EMOJI = re.compile(
    "["
    "\U0001F300-\U0001FAFF"   # symbols & pictographs, emoji, supplemental
    "\U00002600-\U000027BF"   # misc symbols + dingbats (⚙ ⚡ ✨ etc.)
    "\U00002B00-\U00002BFF"   # arrows/stars/squares (⭐ ⬛)
    "\U0001F1E6-\U0001F1FF"   # flags
    "\U0000FE00-\U0000FE0F"   # variation selectors
    "\U00002190-\U000021FF"   # leave plain arrows out? keep → (handled below)
    "]",
    flags=re.UNICODE,
)
# Keep the right-arrow → (U+2192) and a few useful glyphs; strip the rest above.
def strip_emoji(s: str) -> str:
    s = s.replace("→", "@@ARROW@@")
    s = EMOJI.sub("", s)
    s = s.replace("@@ARROW@@", "→")
    return re.sub(r"  +", " ", s).strip()

# ── Inline markdown -> reportlab mini-HTML ────────────────────────────────────
def inline(s: str) -> str:
    s = strip_emoji(s)
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"`(.+?)`", r'<font face="%s">\1</font>' % FONT_MONO, s)
    s = re.sub(r"(?<![\*\w])\*(?!\s)(.+?)(?<!\s)\*(?![\*\w])", r"<i>\1</i>", s)
    return s

# ── Styles ────────────────────────────────────────────────────────────────────
styles = getSampleStyleSheet()
BLUE = colors.HexColor("#1f4e79")
GREY = colors.HexColor("#444444")
LIGHT = colors.HexColor("#eef2f7")
RULE = colors.HexColor("#c8d2de")

def S(name, **kw):
    kw.setdefault("fontName", FONT)
    return ParagraphStyle(name, parent=styles["Normal"], **kw)

st_title = S("t", fontName=FONT_B, fontSize=24, textColor=BLUE, spaceAfter=4, leading=28)
st_sub   = S("s", fontName=FONT_I, fontSize=10.5, textColor=GREY, spaceAfter=10)
st_h2    = S("h2", fontName=FONT_B, fontSize=15, textColor=BLUE, spaceBefore=16, spaceAfter=6, leading=18)
st_h3    = S("h3", fontName=FONT_B, fontSize=12, textColor=colors.HexColor("#2a2a2a"), spaceBefore=10, spaceAfter=4, leading=15)
st_body  = S("b", fontSize=10, leading=15, spaceAfter=6, alignment=TA_LEFT)
st_li    = S("li", fontSize=10, leading=14)
st_quote = S("q", fontSize=10.5, leading=15, fontName=FONT_I, textColor=colors.HexColor("#33475b"),
             leftIndent=10, borderColor=BLUE, borderPadding=(6, 6, 6, 10), backColor=LIGHT, spaceAfter=8)
st_cell  = S("c", fontSize=9, leading=12)
st_cellh = S("ch", fontSize=9, leading=12, fontName=FONT_B, textColor=colors.white)

# ── Parse markdown into flowables ─────────────────────────────────────────────
with open(SRC, encoding="utf-8") as f:
    raw = f.read()
raw = re.sub(r"<!--.*?-->", "", raw, flags=re.DOTALL)   # drop HTML comments
lines = raw.split("\n")

flow = []
i = 0
n = len(lines)

def add_table(block):
    rows = [r.strip().strip("|").split("|") for r in block]
    rows = [[c.strip() for c in r] for r in rows]
    header, body = rows[0], rows[2:]    # rows[1] is the --- separator
    data = [[Paragraph(inline(c), st_cellh) for c in header]]
    for r in body:
        data.append([Paragraph(inline(c), st_cell) for c in r])
    ncol = len(header)
    tbl = Table(data, colWidths=[ (6.7*inch)/ncol ]*ncol, repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), BLUE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT]),
        ("GRID", (0, 0), (-1, -1), 0.5, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    tbl.setStyle(TableStyle(style))
    flow.append(Spacer(1, 4)); flow.append(tbl); flow.append(Spacer(1, 8))

while i < n:
    line = lines[i].rstrip()
    if not line.strip():
        i += 1; continue
    # Tables
    if line.lstrip().startswith("|"):
        block = []
        while i < n and lines[i].lstrip().startswith("|"):
            block.append(lines[i]); i += 1
        if len(block) >= 2:
            add_table(block)
        continue
    # Horizontal rule
    if re.match(r"^---+\s*$", line):
        flow.append(Spacer(1, 4)); flow.append(HRFlowable(width="100%", thickness=0.6, color=RULE)); flow.append(Spacer(1, 4)); i += 1; continue
    # Headings
    if line.startswith("### "):
        flow.append(Paragraph(inline(line[4:]), st_h3)); i += 1; continue
    if line.startswith("## "):
        flow.append(Paragraph(inline(line[3:]), st_h2)); i += 1; continue
    if line.startswith("# "):
        flow.append(Paragraph(inline(line[2:]), st_title)); i += 1; continue
    # Blockquote
    if line.startswith(">"):
        block = []
        while i < n and lines[i].startswith(">"):
            block.append(lines[i].lstrip(">").strip()); i += 1
        flow.append(Paragraph(inline(" ".join(block)), st_quote)); continue
    # Lists (unordered / ordered)
    if re.match(r"^\s*[-*] ", line) or re.match(r"^\s*\d+\. ", line):
        items = []; ordered = bool(re.match(r"^\s*\d+\. ", line))
        while i < n and (re.match(r"^\s*[-*] ", lines[i]) or re.match(r"^\s*\d+\. ", lines[i])):
            txt = re.sub(r"^\s*(?:[-*]|\d+\.)\s+", "", lines[i])
            items.append(ListItem(Paragraph(inline(txt), st_li), leftIndent=14))
            i += 1
        flow.append(ListFlowable(items, bulletType="1" if ordered else "bullet",
                                 bulletFontName=FONT, bulletColor=BLUE, leftIndent=14, spaceAfter=6))
        flow.append(Spacer(1, 2)); continue
    # Subtitle (single italic line right after title)
    if re.match(r"^\*[^*].*\*$", line):
        flow.append(Paragraph(inline(line), st_sub)); i += 1; continue
    # Paragraph
    flow.append(Paragraph(inline(line), st_body)); i += 1

# ── Build with page numbers + footer ──────────────────────────────────────────
def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont(FONT, 8)
    canvas.setFillColor(GREY)
    canvas.drawString(0.9*inch, 0.55*inch, "TradeAnalyzer — User Guide")
    canvas.drawRightString(LETTER[0]-0.9*inch, 0.55*inch, "Page %d" % doc.page)
    canvas.setStrokeColor(RULE)
    canvas.line(0.9*inch, 0.7*inch, LETTER[0]-0.9*inch, 0.7*inch)
    canvas.restoreState()

doc = SimpleDocTemplate(OUT, pagesize=LETTER,
                        leftMargin=0.9*inch, rightMargin=0.9*inch,
                        topMargin=0.8*inch, bottomMargin=0.9*inch,
                        title="TradeAnalyzer — User Guide", author="TradeAnalyzer")
doc.build(flow, onFirstPage=footer, onLaterPages=footer)
print("Wrote", OUT, "(%d flowables)" % len(flow))
