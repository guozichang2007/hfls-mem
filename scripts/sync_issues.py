# -*- coding: utf-8 -*-
"""把仓库 Issues 同步成站点可以直接读的静态 JSON：docs/data/gh-posts.json

为什么要有这一步：
    国内网络下浏览器直连 api.github.com 经常失败（Failed to fetch），页面只能
    降级成本地模式，别人发的帖子就看不到。把 Issues 转成 GitHub Pages 上的静态
    文件后，读取完全不依赖 GitHub 接口，任何网络环境都能看到大家的帖子。

用法:
    python scripts/sync_issues.py                        # 用当前仓库 + GITHUB_TOKEN
    python scripts/sync_issues.py --repo owner/repo       # 指定仓库（匿名读也行，限流 60 次/时）
    python scripts/sync_issues.py --check                # 只比对不写盘（CI 里判断有无变化）
    python scripts/sync_issues.py --out docs/data/gh-posts.json

图片搬运:
    访客在 GitHub 页面里拖进正文的图片（GitHub 托管在 user-attachments），默认会被下载、
    压缩到长边 1280px / 缩略图 640px，存进 docs/assets/img/gh/，JSON 里的 src 换成同源
    相对路径 —— 这样国内网络也能显示，不依赖 *.githubusercontent.com。
    --no-images           只同步文字，不下载图片
    --max-image-bytes     单张上限（默认 5MB）
    --repo-limit-bytes    图片目录总预算（默认 200MB，超了保留远端链接）
    --gc-images           删掉 JSON 里已不再引用的图片文件

环境变量:
    GITHUB_TOKEN / GH_TOKEN   可选；Actions 里用 secrets.GITHUB_TOKEN（5000 次/时）
    GITHUB_REPOSITORY         可选；Actions 自动提供 owner/repo
    GITHUB_API_URL            可选；GitHub Enterprise 用，默认 https://api.github.com

输出格式（与前端 mapIssue 对齐）:
    {
      "generatedAt": "2026-10-24T06:00:00Z",
      "repo": "owner/repo",
      "count": 2,
      "imageCount": 1,            # 已搬到本地的图片数
      "imageBytes": 182736,      # docs/assets/img/gh 目录字节数
      "posts": [
        {"id": "gh-2", "number": 2, "section": "prelude", "author": "郭子畅",
         "login": "guozichang2007", "createdAt": "…", "title": "…", "text": "…",
         "images": [{"src": "assets/img/gh/0123456789ab.jpg",
                     "thumb": "assets/img/gh/thumbs/0123456789ab.jpg",
                     "w": 0, "h": 0, "remote": false}],
         "likeCount": 0, "commentCount": 0, "closed": false,
         "comments": [{"id": "ghc-1", "author": "…", "text": "…",
                       "createdAt": "…", "origin": "github"}],
         "url": "https://github.com/owner/repo/issues/2"}
      ]
    }
"""
import argparse
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

try:  # Windows 控制台默认 GBK，中文日志会炸
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "docs", "data", "gh-posts.json")
API = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")

META_RE = re.compile(r"<!--\s*hfls:(\{[\s\S]*?\})\s*-->")
# markdown 图片 + GitHub 拖图插入的 <img src="…">（与前端 extractImages 同一套规则）
IMG_ANY_RE = re.compile(
    r"!\[[^\]]*\]\((https?://[^\s)]+)\)|<img\b[^>]*\bsrc=[\"'](https?://[^\"']+)[\"']",
    re.I,
)
# base64 图（data:）在 Issue 里既传不上去也没法显示，直接丢掉免得把正文撑爆
DATA_IMG_RE = re.compile(
    r"!\[[^\]]*\]\(\s*data:[^)\s]*\)|<img\b[^>]*\bsrc=[\"']data:[^\"']*[\"'][^>]*>",
    re.I,
)
SEC_PREFIX = "sec-"
PER_PAGE = 100
MAX_ISSUE_PAGES = 10      # 最多 1000 条 Issue
MAX_COMMENT_PAGES = 3     # 单条最多 300 条评论
RETRIES = 3

# ---- 图片搬运（把 GitHub 托管的图变成本站同源文件，墙内才看得到）----
IMG_DIR = os.path.join(ROOT, "docs", "assets", "img", "gh")
IMG_THUMB_DIR = os.path.join(IMG_DIR, "thumbs")
IMG_REL_DIR = "assets/img/gh"
IMG_REL_THUMB_DIR = "assets/img/gh/thumbs"
MIRROR_PREFIXES = (
    "https://github.com/user-attachments/",
    "https://user-images.githubusercontent.com/",
    "https://private-user-images.githubusercontent.com/",
    "https://objects.githubusercontent.com/",
    "https://raw.githubusercontent.com/",
    "https://camo.githubusercontent.com/",
)
MAX_MIRROR_PER_POST = 9          # 单帖最多搬 9 张（与前端展示上限一致）
IMG_TIMEOUT = 20
MAX_IMAGE_BYTES = 5 * 1024 * 1024
REPO_IMAGE_BUDGET = 200 * 1024 * 1024
MAX_EDGE = 1280
THUMB_EDGE = 640
JPEG_QUALITY = 72

try:  # Pillow 可选：没装就只搬本来就是 JPEG 的原图
    from PIL import Image
except Exception:  # pragma: no cover
    Image = None


def log(msg):
    print(msg, flush=True)


def warn(msg):
    print(msg, file=sys.stderr, flush=True)


def gh_get(path, token, tries=RETRIES):
    """GET 一个 API 路径，网络抖动 / 5xx / 限流时重试。"""
    url = path if path.startswith("http") else API + path
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "hfls-mem-sync",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = "Bearer " + token

    last = None
    for attempt in range(1, tries + 1):
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.loads(res.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as err:
            body = ""
            try:
                body = err.read().decode("utf-8", "replace")
            except Exception:
                pass
            msg = ""
            try:
                msg = (json.loads(body) or {}).get("message") or ""
            except Exception:
                msg = body[:120]
            last = "HTTP %s %s" % (err.code, msg)
            if err.code in (401, 404):
                raise RuntimeError(last)
            if err.code in (403, 429) and err.headers.get("X-RateLimit-Remaining") == "0":
                raise RuntimeError("GitHub 接口限流（未登录 60 次/时），"
                                   "请给一个 GITHUB_TOKEN 环境变量")
            if err.code < 500 and err.code not in (403, 429):
                raise RuntimeError(last)
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            last = "网络错误：%s" % (getattr(err, "reason", None) or err)
        if attempt < tries:
            wait = 1.5 * attempt
            warn("第 %d 次请求失败（%s），%.1fs 后重试…" % (attempt, last, wait))
            time.sleep(wait)
    raise RuntimeError(last or "未知错误")


def gh_pages(path_fmt, token, max_pages=MAX_ISSUE_PAGES):
    """按 per_page=100 翻页抓取，path_fmt 里用 {page} 占位。"""
    out = []
    for page in range(1, max_pages + 1):
        chunk = gh_get(path_fmt.format(page=page), token) or []
        out.extend(chunk)
        if len(chunk) < PER_PAGE:
            break
    return out


def split_meta(body):
    """拆出 `<!-- hfls:{"name":"…"} -->` 隐藏标记，返回 (meta, 正文)。"""
    text = body or ""
    meta = {}
    m = META_RE.search(text)
    if m:
        try:
            meta = json.loads(m.group(1)) or {}
        except ValueError:
            meta = {}
        text = META_RE.sub("", text)
    return meta, text.strip()


def take_images(text):
    """把正文里的图片抽成 images 数组（markdown 与 <img src> 都认，与前端一致）。"""
    images = []

    def repl(m):
        src = m.group(1) or m.group(2) or ""
        if src and src not in [im["src"] for im in images]:
            images.append({"src": src, "thumb": src, "w": 0, "h": 0, "remote": True})
        return ""

    clean = IMG_ANY_RE.sub(repl, DATA_IMG_RE.sub("", text or ""))
    clean = re.sub(r"\n{3,}", "\n\n", clean).strip()
    return clean, images


def should_mirror(src):
    """只搬 GitHub 自己托管的图；第三方图床保持远端链接（版权/体积都不该替人搬）。"""
    low = (src or "").lower()
    return any(low.startswith(p) for p in MIRROR_PREFIXES)


def dir_size(path):
    total = 0
    for base, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(base, name))
            except OSError:
                pass
    return total


def is_jpeg(data):
    return data[:3] == b"\xff\xd8\xff"


def show_path(path):
    """日志里优先显示相对仓库的路径；跨盘符（--out 指到别的盘）就原样显示。"""
    try:
        return os.path.relpath(path, ROOT)
    except ValueError:
        return path


def fmt_size(n):
    n = float(n)
    if n >= 1024 * 1024:
        return "%.1f MB" % (n / 1024 / 1024)
    if n >= 1024:
        return "%.0f KB" % (n / 1024)
    return "%d B" % n


def encode_jpeg(data, edge, quality=JPEG_QUALITY):
    """缩小到长边 edge 后转 JPEG；没装 Pillow / 解码失败返回 None。"""
    if Image is None:
        return None
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        width, height = img.size
        scale = min(1.0, float(edge) / max(width, height, 1))
        if scale < 1.0:
            resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", 1)
            img = img.resize((max(1, int(width * scale)), max(1, int(height * scale))), resample)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
        return buf.getvalue()
    except Exception:
        return None


def fetch_image(url, max_bytes=MAX_IMAGE_BYTES):
    """下载一张图，返回 bytes；非图片或超大直接抛错。"""
    req = urllib.request.Request(url, headers={
        "User-Agent": "hfls-mem-sync",
        "Accept": "image/*,*/*;q=0.8",
    })
    with urllib.request.urlopen(req, timeout=IMG_TIMEOUT) as res:
        ctype = (res.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype and not ctype.startswith("image/"):
            raise RuntimeError("不是图片（%s）" % ctype)
        data = res.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise RuntimeError("超过单张上限 %s" % fmt_size(max_bytes))
    if not data:
        raise RuntimeError("空文件")
    return data


def encode_upload(data, src):
    """把下载到的图编码成 (rel, rel_thumb, 文件名, 大图字节, 缩略图字节)，先不落盘。"""
    name = hashlib.sha1(src.encode("utf-8")).hexdigest()[:12] + ".jpg"
    full = encode_jpeg(data, MAX_EDGE)
    if full is None:
        if not is_jpeg(data):  # 没 Pillow 又不认识格式：宁可不搬，也不留个坏文件
            raise RuntimeError("不是 JPEG，且没装 Pillow 无法转换")
        full = data
    thumb = encode_jpeg(data, THUMB_EDGE) or full
    return IMG_REL_DIR + "/" + name, IMG_REL_THUMB_DIR + "/" + name, name, full, thumb


def write_upload(name, full, thumb):
    """落地到 docs/assets/img/gh/，返回写入字节数（文件已存在则 0）。"""
    full_path = os.path.join(IMG_DIR, name)
    thumb_path = os.path.join(IMG_THUMB_DIR, name)
    if os.path.exists(full_path) and os.path.exists(thumb_path):
        return 0
    os.makedirs(IMG_THUMB_DIR, exist_ok=True)
    written = 0
    for path, blob in ((full_path, full), (thumb_path, thumb)):
        if os.path.exists(path):
            continue
        with open(path, "wb") as f:
            f.write(blob)
        written += len(blob)
    return written


def mirror_images(posts, budget=REPO_IMAGE_BUDGET, disabled=False, max_bytes=MAX_IMAGE_BYTES):
    """把 GitHub 托管的图片搬进 docs/assets/img/gh/，并把 JSON 里的地址换成本地相对路径。

    返回 (搬运张数, 保留远端张数, 目录字节数)。失败只 warn，不中断同步。
    """
    if disabled:
        return 0, 0, dir_size(IMG_DIR)
    used = dir_size(IMG_DIR)
    mirrored = 0
    remote = 0
    full = used >= budget
    if full:
        warn("图片目录已达 %s 预算上限，本次图片保留远端链接" % fmt_size(budget))
    for post in posts:
        done = 0
        for im in post.get("images") or []:
            src = im.get("src") or ""
            if not should_mirror(src):
                remote += 1
                continue
            if done >= MAX_MIRROR_PER_POST or full:
                remote += 1
                continue
            try:
                data = fetch_image(src, max_bytes)
                rel, rel_thumb, name, big, small = encode_upload(data, src)
            except Exception as err:  # noqa: BLE001 - 单张失败不该影响整次同步
                warn("图片搬运失败，保留远端链接：%s（%s）" % (src, err))
                remote += 1
                continue
            cached = (os.path.exists(os.path.join(IMG_DIR, name))
                      and os.path.exists(os.path.join(IMG_THUMB_DIR, name)))
            if not cached and used + len(big) + len(small) > budget:
                warn("图片目录已超过 %s 预算，后续图片保留远端链接" % fmt_size(budget))
                full = True
                remote += 1
                continue
            used += write_upload(name, big, small)
            im["src"] = rel
            im["thumb"] = rel_thumb
            im["remote"] = False
            mirrored += 1
            done += 1
    return mirrored, remote, used


def prune_images(posts):
    """--gc-images：删掉当前 JSON 不再引用的图片文件。"""
    keep = set()
    for post in posts:
        for im in post.get("images") or []:
            for key in ("src", "thumb"):
                val = str(im.get(key) or "")
                if val.startswith(IMG_REL_DIR + "/"):
                    keep.add(os.path.basename(val))
    removed = 0
    for path in (IMG_DIR, IMG_THUMB_DIR):
        if not os.path.isdir(path):
            continue
        for name in os.listdir(path):
            if name in keep:
                continue
            if name.startswith(".") or not name.lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".gif")):
                continue  # 别动 .gitkeep / README 之类
            target = os.path.join(path, name)
            if os.path.isfile(target):
                try:
                    os.remove(target)
                    removed += 1
                except OSError:
                    pass
    return removed


def section_of(labels, default_section):
    for name in labels:
        if name.startswith(SEC_PREFIX) and len(name) > len(SEC_PREFIX):
            return name[len(SEC_PREFIX):]
    return default_section


def to_comment(raw):
    meta, text = split_meta(raw.get("body") or "")
    login = (raw.get("user") or {}).get("login") or ""
    return {
        "id": "ghc-%s" % raw.get("id"),
        "author": meta.get("name") or login or "同学",
        "text": text,
        "createdAt": raw.get("created_at"),
        "origin": "github",
        "url": raw.get("html_url") or "",
    }


def fetch_comments(repo, number, token):
    path = "/repos/%s/issues/%s/comments?per_page=%d&page={page}" % (repo, number, PER_PAGE)
    return [to_comment(c) for c in gh_pages(path, token, max_pages=MAX_COMMENT_PAGES)]


def load_sections():
    """从 docs/data/posts.json 读合法板块 id（读不到就返回空，不做校验）。"""
    path = os.path.join(ROOT, "docs", "data", "posts.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return [s.get("id") for s in (data.get("sections") or []) if s.get("id")]
    except (ValueError, OSError):
        return []


def to_post(repo, issue, token, default_section, sections=None):
    meta, text = split_meta(issue.get("body") or "")
    text, images = take_images(text)
    login = (issue.get("user") or {}).get("login") or ""
    labels = [lab.get("name") or "" for lab in (issue.get("labels") or [])]
    number = issue.get("number")
    comments = fetch_comments(repo, number, token) if issue.get("comments") else []
    # 板块优先取隐藏标记里的（非协作者发帖时 labels 参数会被 GitHub 忽略），
    # 标记里的值不认识就退回标签 / 默认板块
    section = meta.get("section") or ""
    if sections and section not in sections:
        section = ""
    section = section or section_of(labels, default_section)
    return {
        "id": "gh-%s" % number,
        "number": number,
        "section": section,
        "author": meta.get("name") or login or "同学",
        "login": login,
        "createdAt": issue.get("created_at"),
        "title": issue.get("title") or "",
        "text": text,
        "images": images,
        "likeCount": (issue.get("reactions") or {}).get("total_count") or 0,
        "commentCount": issue.get("comments") or 0,
        "closed": issue.get("state") == "closed",
        "comments": comments,
        "url": issue.get("html_url") or "",
    }


def collect(repo, token, default_section):
    path = "/repos/%s/issues?state=all&per_page=%d&page={page}" % (repo, PER_PAGE)
    sections = load_sections()
    if sections and default_section not in sections:
        default_section = "classmate" if "classmate" in sections else sections[0]
    issues = [i for i in gh_pages(path, token) if not i.get("pull_request")]
    posts = [to_post(repo, i, token, default_section, sections) for i in issues]
    posts.sort(key=lambda p: p.get("createdAt") or "", reverse=True)
    return posts


def load_old(path):
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (ValueError, OSError):
        return None


def write_out(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def plan_mirror(posts):
    """--check 用：不下载，只按 URL 推出「应该存成哪个相对路径」，保证比对结果稳定。"""
    for post in posts:
        for im in post.get("images") or []:
            src = im.get("src") or ""
            if not should_mirror(src):
                continue
            name = hashlib.sha1(src.encode("utf-8")).hexdigest()[:12] + ".jpg"
            im["src"] = IMG_REL_DIR + "/" + name
            im["thumb"] = IMG_REL_THUMB_DIR + "/" + name
            im["remote"] = False
    return posts


def main(argv=None):
    ap = argparse.ArgumentParser(description="同步 GitHub Issues 成静态 JSON")
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""),
                    help="owner/repo，默认取 GITHUB_REPOSITORY")
    ap.add_argument("--token",
                    default=os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or "",
                    help="GitHub token，默认取 GITHUB_TOKEN / GH_TOKEN")
    ap.add_argument("--out", default=DEFAULT_OUT, help="输出文件，默认 docs/data/gh-posts.json")
    ap.add_argument("--default-section", default="classmate",
                    help="没有 sec-* 标签的帖子落到哪个板块，默认 classmate")
    ap.add_argument("--check", action="store_true", help="只比对，不写文件")
    ap.add_argument("--no-images", action="store_true", help="不下载/搬运图片，只同步文字")
    ap.add_argument("--max-image-bytes", type=int, default=MAX_IMAGE_BYTES,
                    help="单张图片上限（字节，默认 5MB）")
    ap.add_argument("--repo-limit-bytes", type=int, default=REPO_IMAGE_BUDGET,
                    help="图片目录总预算（字节，默认 200MB）")
    ap.add_argument("--gc-images", action="store_true", help="删掉 JSON 不再引用的图片文件")
    args = ap.parse_args(argv)

    repo = (args.repo or "").strip().strip("/")
    if not repo or "/" not in repo:
        warn("缺少仓库：用 --repo owner/repo 或设置 GITHUB_REPOSITORY")
        return 2

    log("同步 %s 的 Issues → %s" % (repo, show_path(args.out)))
    try:
        posts = collect(repo, args.token, args.default_section)
    except RuntimeError as err:
        warn("同步失败：%s" % err)
        return 1

    # 图片要在比较之前处理：JSON 里的地址换成本地相对路径后，比对才有意义
    if args.check:
        plan_mirror(posts)
        mirrored, kept_remote, img_bytes = 0, 0, dir_size(IMG_DIR)
    else:
        try:
            mirrored, kept_remote, img_bytes = mirror_images(
                posts, budget=args.repo_limit_bytes,
                disabled=args.no_images, max_bytes=args.max_image_bytes)
        except Exception as err:  # pragma: no cover - 兜底，别让整次同步挂掉
            warn("图片搬运跳过：%s" % err)
            mirrored, kept_remote, img_bytes = 0, 0, dir_size(IMG_DIR)
        if args.gc_images:
            removed = prune_images(posts)
            if removed:
                log("清理孤儿图片：%d 个文件" % removed)
            img_bytes = dir_size(IMG_DIR)
        if mirrored or kept_remote:
            log("图片：搬运 %d 张，保留远端 %d 张，目录共 %s" %
                (mirrored, kept_remote, fmt_size(img_bytes)))

    image_count = sum(1 for p in posts for im in (p.get("images") or []) if not im.get("remote"))
    old = load_old(args.out)
    if (old and old.get("repo") == repo and old.get("posts") == posts
            and old.get("imageCount") == image_count):
        log("无变化：%d 条帖子，跳过写入" % len(posts))
        return 0

    if args.check:
        log("有变化：%d 条帖子 / %d 张本地图（--check 模式，不写盘）" % (len(posts), image_count))
        return 0

    payload = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "repo": repo,
        "count": len(posts),
        "imageCount": image_count,
        "imageBytes": img_bytes,
        "posts": posts,
    }
    write_out(args.out, payload)
    n_comments = sum(len(p["comments"]) for p in posts)
    log("完成：%d 条帖子 / %d 条评论 / %d 张本地图 → %s" %
        (len(posts), n_comments, image_count, show_path(args.out)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

