# -*- coding: utf-8 -*-
"""Dump the docx content as a linear list of blocks (paragraph text + inline images).

Usage: python scripts/docx_dump.py <docx> <out.txt>
"""
import sys
import zipfile
import re
from xml.etree import ElementTree as ET

NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "v": "urn:schemas-microsoft-com:vml",
}


def rels(z):
    out = {}
    xml = z.read("word/_rels/document.xml.rels")
    for rel in ET.fromstring(xml):
        out[rel.get("Id")] = rel.get("Target")
    return out


def para_text(p):
    parts = []
    for node in p.iter():
        tag = node.tag.split("}")[-1]
        if tag == "t":
            parts.append(node.text or "")
        elif tag == "br":
            parts.append("\n")
        elif tag == "tab":
            parts.append("\t")
        elif tag == "drawing":
            ids = []
            for blip in node.iter("{%s}blip" % NS["a"]):
                ids.append(blip.get("{%s}embed" % NS["r"]))
            for imagedata in node.iter("{%s}imagedata" % NS["v"]):
                ids.append(imagedata.get("{%s}id" % NS["r"]))
            parts.append("[[IMG:%s]]" % ",".join([i for i in ids if i]))
        elif tag == "pict":
            ids = []
            for imagedata in node.iter("{%s}imagedata" % NS["v"]):
                ids.append(imagedata.get("{%s}id" % NS["r"]))
            if ids:
                parts.append("[[IMG:%s]]" % ",".join([i for i in ids if i]))
    return "".join(parts)


def main():
    docx, out = sys.argv[1], sys.argv[2]
    z = zipfile.ZipFile(docx)
    rmap = rels(z)
    doc = ET.fromstring(z.read("word/document.xml"))
    body = doc.find("w:body", NS)
    lines = []
    for el in body:
        tag = el.tag.split("}")[-1]
        if tag == "p":
            txt = para_text(el)
            style = el.find("w:pPr/w:pStyle", NS)
            style = style.get("{%s}val" % NS["w"]) if style is not None else ""
            if txt.strip() or "[[IMG" in txt:
                lines.append("PARA[%s]\t%s" % (style, txt.replace("\n", "\\n")))
        elif tag == "tbl":
            lines.append("TABLE-START")
            for row in el.findall("w:tr", NS):
                cells = []
                for cell in row.findall("w:tc", NS):
                    cells.append(" / ".join(para_text(p) for p in cell.findall("w:p", NS)))
                lines.append("ROW\t" + " | ".join(cells))
            lines.append("TABLE-END")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
        f.write("\n")
    print("blocks:", len(lines))
    # resolve images referenced
    imgs = sorted(set(re.findall(r"\[\[IMG:([^\]]+)\]\]", "\n".join(lines))))
    files = []
    for i in imgs:
        for rid in i.split(","):
            files.append(rmap.get(rid, "?"))
    print("image refs:", len(files))
    for f_ in files:
        try:
            print(f_, z.getinfo("word/" + f_).file_size)
        except KeyError:
            print(f_, "MISSING")


if __name__ == "__main__":
    main()
