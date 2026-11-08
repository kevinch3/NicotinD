# shellcheck shell=bash
# ci_tool_fetch <file> <url> <sha256> — puts a pinned CI tool archive at ./<file>.
# A cached copy (~/.cache/nicotind-ci-tools, restored by actions/cache) is used
# when its checksum matches; otherwise it is downloaded with retries, because a
# GitHub release-CDN outage answers 504 for hours (#1746). The checksum is
# verified on every path, so neither the cache nor a retried download is trusted
# blind.
ci_tool_fetch() {
  local file=$1 url=$2 sha=$3 cache="$HOME/.cache/nicotind-ci-tools"
  mkdir -p "$cache" || return 1
  if ! echo "${sha}  ${cache}/${file}" | sha256sum -c - >/dev/null 2>&1; then
    curl -fsSL --retry "${CI_TOOL_FETCH_RETRIES:-8}" --retry-all-errors --retry-delay 15 --connect-timeout 20 \
      -o "${cache}/${file}" "$url" || return 1
  fi
  # Fail closed on its own, not only under the caller's `set -e`.
  echo "${sha}  ${cache}/${file}" | sha256sum -c - || return 1
  cp "${cache}/${file}" "./${file}" || return 1
}
