from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from pipeline_errors import TextLayoutError


DEFAULT_FONT = "C:/Windows/Fonts/arialbd.ttf"
NAVY = (22, 38, 76, 220)
ORANGE = (255, 140, 26, 255)
WHITE = (255, 255, 255, 255)


def font(path, size):
    try:
        return ImageFont.truetype(str(path), size)
    except OSError as exc:
        raise TextLayoutError(f"字体不可用: {path}") from exc


def wrap_text(draw, text, typeface, max_width, max_lines=2):
    if not text or not text.strip():
        raise TextLayoutError("字幕/标签不能为空")
    paragraphs = text.strip().splitlines()
    lines = []
    for paragraph in paragraphs:
        words = paragraph.split()
        if not words:
            raise TextLayoutError("字幕/标签不能包含空行")
        current = ""
        for word in words:
            candidate = (current + " " + word).strip()
            if draw.textlength(candidate, font=typeface) <= max_width:
                current = candidate
                continue
            if not current or draw.textlength(word, font=typeface) > max_width:
                raise TextLayoutError(f"单词超出版心，无法完整排版: {word}")
            lines.append(current)
            current = word
            if len(lines) > max_lines:
                raise TextLayoutError("文字超过两行，禁止静默截断；请缩短文案")
        if current:
            lines.append(current)
        if len(lines) > max_lines:
            raise TextLayoutError("文字超过两行，禁止静默截断；请缩短文案")
    if len(lines) > max_lines:
        raise TextLayoutError("文字超过两行，禁止静默截断；请缩短文案")
    return lines


def layout_text(text, width, font_path=DEFAULT_FONT, max_size=58, min_size=26, max_lines=2):
    probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    max_width = width - 2 * max(32, width // 16)
    for size in range(max_size, min_size - 1, -2):
        typeface = font(font_path, size)
        try:
            lines = wrap_text(probe, text, typeface, max_width, max_lines=max_lines)
        except TextLayoutError:
            continue
        return {"font": typeface, "font_size": size, "lines": lines, "max_width": max_width}
    raise TextLayoutError(f"文字在两行和最小字号 {min_size}px 内仍无法完整排版: {text}")


def make_text_overlay(text, output, width, height, role, font_path=DEFAULT_FONT):
    if role not in {"cover", "main"}:
        raise TextLayoutError(f"未知文字层角色: {role}")
    maximum = 68 if role == "cover" else 56
    layout = layout_text(text, width, font_path=font_path, max_size=maximum,
                         min_size=28 if role == "cover" else 26)
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    lines = layout["lines"]
    line_height = int(layout["font_size"] * 1.30)
    band_height = 52 + line_height * len(lines)
    y0 = 72 if role == "cover" else height - band_height - 72
    draw.rectangle((0, y0, width, y0 + band_height), fill=NAVY)
    draw.rectangle((0, y0, width, y0 + 6), fill=ORANGE)
    for index, line in enumerate(lines):
        y = y0 + 30 + line_height * index + line_height // 2
        draw.text((width // 2, y), line, font=layout["font"], fill=WHITE, anchor="mm",
                  stroke_width=1, stroke_fill=(10, 16, 34, 255))
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output)
    return {"text": text, "lines": lines, "font_size": layout["font_size"], "path": str(output)}
