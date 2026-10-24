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

环境变量:
    GITHUB_TOKEN / GH_TOKEN   可选；Actions 里用 secrets.GITHUB_TOKEN（5000 次/时）
    GITHUB_REPOSITORY         可选；Actions 自动提供 owner/repo
    GITHUB_API_URL            可选；GitHub Enterprise 用，默认 https://api.github.com

输出格式（与前端 mapIssue 对齐）:
    {
      "generatedAt": "2026-10-24T06:00:00Z",
      "repo": "owner/repo",
      "count": 2,
      "posts": [
        {"id": "gh-2", "number": 2, "section": "prelude", "author": "郭子畅",
         "login": "guozichang2007", "createdAt": "…", "title": "…", "text": "…",
         "images": [{"src": "…", "thumb": "…", "w": 0, "h": 0, "remote": true}],
         "likeCount": 0, "commentCount": 0, "closed": false,
         "comments": [{"id": "ghc-1", "author": "…", "text": "…",
                       "createdAt": "…", "origin": "github"}],
         "url": "https://github.com/owner/repo/issues/2"}
      ]
    }
"""
import argparse
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
MD_IMG_RE = re.compile(r"!\[[^\]]*\]\((https?://[^\s)]+)\)")
SEC_PREFIX = "sec-"
PER_PAGE = 100
MAX_ISSUE_PAGES = 10      # 最多 1000 条 Issue
MAX_COMMENT_PAGES = 3     # 单条最多 300 条评论
RETRIES = 3


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
    """把正文里的 markdown 图片抽成 images 数组（与前端 extractImages 一致）。"""
    images = []

    def repl(m):
        images.append({"src": m.group(1), "thumb": m.group(1), "w": 0, "h": 0, "remote": True})
        return ""

    clean = MD_IMG_RE.sub(repl, text or "")
    clean = re.sub(r"\n{3,}", "\n\n", clean).strip()
    return clean, images


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
    args = ap.parse_args(argv)

    repo = (args.repo or "").strip().strip("/")
    if not repo or "/" not in repo:
        warn("缺少仓库：用 --repo owner/repo 或设置 GITHUB_REPOSITORY")
        return 2

    log("同步 %s 的 Issues → %s" % (repo, os.path.relpath(args.out, ROOT)))
    try:
        posts = collect(repo, args.token, args.default_section)
    except RuntimeError as err:
        warn("同步失败：%s" % err)
        return 1

    old = load_old(args.out)
    if old and old.get("repo") == repo and old.get("posts") == posts:
        log("无变化：%d 条帖子，跳过写入" % len(posts))
        return 0

    if args.check:
        log("有变化：%d 条帖子（--check 模式，不写盘）" % len(posts))
        return 0

    payload = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "repo": repo,
        "count": len(posts),
        "posts": posts,
    }
    write_out(args.out, payload)
    n_comments = sum(len(p["comments"]) for p in posts)
    log("完成：%d 条帖子 / %d 条评论 → %s" %
        (len(posts), n_comments, os.path.relpath(args.out, ROOT)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

