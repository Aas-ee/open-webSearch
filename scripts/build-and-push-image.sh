#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
REPOSITORY=${OPEN_WEBSEARCH_IMAGE_REPOSITORY:-}
TAG=${OPEN_WEBSEARCH_IMAGE_TAG:-}
PLATFORMS=${OPEN_WEBSEARCH_IMAGE_PLATFORMS:-linux/amd64}
ALLOW_DIRTY=false
TAG_EXPLICIT=false
ALIASES=()

[[ -z "$TAG" ]] || TAG_EXPLICIT=true

usage() {
  cat <<'EOF'
用法：scripts/build-and-push-image.sh --repository <镜像仓库> [选项]

在本机使用 Docker Buildx 构建并推送 open-webSearch 镜像，不依赖 GitHub Actions。

必填：
  --repository <地址>  不含 tag 的镜像仓库，例如 harbor.example.com/lingjing/open-websearch

选项：
  --tag <tag>          镜像 tag；默认使用当前 Git commit 的前 12 位
  --alias <tag>        同时推送一个别名，可重复，例如 --alias dev
  --platform <列表>    Buildx 平台；默认 linux/amd64
  --allow-dirty        允许工作区有未提交改动；默认拒绝，避免 commit tag 与内容不一致
  -h, --help           显示帮助

也可通过环境变量提供默认值：
  OPEN_WEBSEARCH_IMAGE_REPOSITORY
  OPEN_WEBSEARCH_IMAGE_TAG
  OPEN_WEBSEARCH_IMAGE_PLATFORMS

示例：
  docker login harbor.example.com
  ./scripts/build-and-push-image.sh \
    --repository harbor.example.com/lingjing/open-websearch \
    --alias dev
EOF
}

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --repository)
      [[ $# -ge 2 ]] || die "--repository 缺少参数"
      REPOSITORY=$2
      shift 2
      ;;
    --tag)
      [[ $# -ge 2 ]] || die "--tag 缺少参数"
      TAG=$2
      TAG_EXPLICIT=true
      shift 2
      ;;
    --alias)
      [[ $# -ge 2 ]] || die "--alias 缺少参数"
      ALIASES+=("$2")
      shift 2
      ;;
    --platform)
      [[ $# -ge 2 ]] || die "--platform 缺少参数"
      PLATFORMS=$2
      shift 2
      ;;
    --allow-dirty)
      ALLOW_DIRTY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "未知参数：$1" ;;
  esac
done

for command in docker git; do
  command -v "$command" >/dev/null || die "缺少命令：$command"
done
docker buildx version >/dev/null 2>&1 || die "Docker Buildx 不可用"

[[ -n "$REPOSITORY" ]] || die "必须通过 --repository 或 OPEN_WEBSEARCH_IMAGE_REPOSITORY 指定镜像仓库"
[[ "$REPOSITORY" != *://* && "$REPOSITORY" != *@* && "$REPOSITORY" != *[[:space:]]* ]] \
  || die "镜像仓库格式不合法：$REPOSITORY"
[[ "$REPOSITORY" == */* ]] || die "镜像仓库必须包含 registry/project 路径：$REPOSITORY"
[[ "${REPOSITORY##*/}" != *:* ]] || die "--repository 不能包含 tag，请使用 --tag"
[[ -n "$PLATFORMS" && "$PLATFORMS" != *[[:space:]]* ]] || die "--platform 格式不合法：$PLATFORMS"

COMMIT=$(git -C "$ROOT" rev-parse --verify HEAD)
SHORT_COMMIT=${COMMIT:0:12}
DIRTY=$(git -C "$ROOT" status --porcelain --untracked-files=normal)
if [[ -n "$DIRTY" && "$ALLOW_DIRTY" != true ]]; then
  die "工作区存在未提交改动；请先提交，或仅在临时测试时使用 --allow-dirty"
fi

if [[ -z "$TAG" ]]; then
  TAG=$SHORT_COMMIT
  if [[ -n "$DIRTY" ]]; then
    TAG="${TAG}-dirty-$(date -u +%Y%m%d%H%M%S)"
  fi
fi

validate_tag() {
  local value=$1
  [[ "$value" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "镜像 tag 不合法：$value"
}

validate_tag "$TAG"
for alias in "${ALIASES[@]}"; do
  validate_tag "$alias"
done

PRIMARY_IMAGE="$REPOSITORY:$TAG"
BUILD_ARGS=(
  --platform "$PLATFORMS"
  --provenance=false
  --label "org.opencontainers.image.revision=$COMMIT"
  --tag "$PRIMARY_IMAGE"
)
for alias in "${ALIASES[@]}"; do
  BUILD_ARGS+=(--tag "$REPOSITORY:$alias")
done

printf '构建并推送 %s（platform=%s）\n' "$PRIMARY_IMAGE" "$PLATFORMS"
docker buildx build "${BUILD_ARGS[@]}" --push "$ROOT"

printf '完成：%s\n' "$PRIMARY_IMAGE"
printf '测试环境配置：OPEN_WEBSEARCH_IMAGE=%s\n' "$PRIMARY_IMAGE"
if [[ -n "$DIRTY" && "$TAG_EXPLICIT" == true ]]; then
  printf '注意：镜像包含未提交改动，显式 tag=%s 不代表纯净 Git 版本。\n' "$TAG" >&2
fi
