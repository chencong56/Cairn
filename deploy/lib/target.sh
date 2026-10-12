# 内部：读 deploy/targets/*.conf。不要直接跑。
# 兼容 macOS bash 3.2，不用关联数组。

target_kv() {
  # target_kv FILE KEY   —— 只读清单顶部（第一个 [section] 之前）
  awk -v want="$2" '
    /^[ \t]*#/ { next }
    /^[ \t]*$/ { next }
    /^\[/ { exit }
    {
      eq = index($0, "=")
      if (eq < 1) next
      key = substr($0, 1, eq - 1)
      if (key == want) {
        print substr($0, eq + 1)
        exit
      }
    }
  ' "$1"
}

target_host_ids() {
  awk '
    /^\[host\./ {
      id = $0
      sub(/^\[host\./, "", id)
      sub(/\]$/, "", id)
      print id
    }
  ' "$1"
}

target_host_kv() {
  # target_host_kv FILE HOST KEY
  awk -v host="$2" -v want="$3" '
    $0 == "[host." host "]" { insec = 1; next }
    /^\[/ { insec = 0 }
    insec {
      if ($0 ~ /^[ \t]*#/ || $0 ~ /^[ \t]*$/) next
      eq = index($0, "=")
      if (eq < 1) next
      key = substr($0, 1, eq - 1)
      if (key == want) {
        print substr($0, eq + 1)
        exit
      }
    }
  ' "$1"
}

target_containers() {
  awk '
    /^(restart|accessories)=/ {
      line = $0
      sub(/^[^=]+=/, "", line)
      n = split(line, a, /[[:space:]]+/)
      for (i = 1; i <= n; i++) if (a[i] != "") print a[i]
    }
  ' "$1"
}

target_assert_readable() {
  if [ ! -f "$1" ]; then
    echo "找不到目标清单 $1" >&2
    return 1
  fi
  if awk 'BEGIN{r=1} /^[ \t]*[^#[ \t].*(PASSWORD|SECRET|ACCESS_KEY|CREDENTIAL)/{r=0; exit} END{exit r}' "$1"
  then
    echo "目标清单 $1 含密钥键名，拒绝继续" >&2
    return 1
  fi
  return 0
}

target_assert_disjoint() {
  local a="$1" b="$2" overlap
  overlap=$(comm -12 <(target_containers "$a" | sort -u) <(target_containers "$b" | sort -u))
  if [ -n "$overlap" ]; then
    echo "目标清单容器名相交：" >&2
    echo "$overlap" >&2
    return 1
  fi
  return 0
}

target_has_hosts() {
  [ -n "$(target_host_ids "$1")" ]
}

target_accessories() {
  awk -F= '/^accessories=/ { print $2 }' "$1"
}

target_assert_restart_safe() {
  local file="$1" acc rest overlap
  acc=$(target_accessories "$file" | tr ' ' '\n' | sort -u)
  rest=$(awk -F= '/^restart=/ { print $2 }' "$file" | tr ' ' '\n' | sort -u)
  overlap=$(comm -12 <(printf '%s\n' "$acc") <(printf '%s\n' "$rest"))
  if [ -n "$overlap" ]; then
    echo "restart 与 accessories 重名，拒绝发布：" >&2
    echo "$overlap" >&2
    return 1
  fi
  return 0
}
