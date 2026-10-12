# 内部：发布 / 回滚 / 集群探活。由 ./deploy/cairn 调用，不要直接跑。

load_cluster() {
  CLUSTER_TARGET="${CAIRN_TARGET:-cluster}"
  CLUSTER_CONF="$HERE/targets/${CLUSTER_TARGET}.conf"
  target_assert_readable "$CLUSTER_CONF" || exit 1
  if [ "$CLUSTER_TARGET" = "dev-infra" ]; then
    die "dev-infra 不是发布目标，请用 ./deploy/cairn dev-infra up|status|down"
  fi
  if [ "$CLUSTER_TARGET" = "single" ] || ! target_has_hosts "$CLUSTER_CONF"; then
    die "目标 ${CLUSTER_TARGET} 没有 [host.*]，还没有单机全套编排"
  fi
  target_assert_restart_safe "$CLUSTER_CONF" || exit 1
  if [ -f "$HERE/targets/dev-infra.conf" ]; then
    target_assert_disjoint "$CLUSTER_CONF" "$HERE/targets/dev-infra.conf" || exit 1
  fi
  CLUSTER_NAME=$(target_kv "$CLUSTER_CONF" name)
  CLUSTER_ROOT=$(target_kv "$CLUSTER_CONF" remote_root)
  CLUSTER_BUILD_HOST=$(target_kv "$CLUSTER_CONF" build_host)
  CLUSTER_ENTRY=$(target_kv "$CLUSTER_CONF" entry_health)
  CLUSTER_ACCESSORIES=$(target_accessories "$CLUSTER_CONF")
  [ -n "$CLUSTER_BUILD_HOST" ] || die "清单缺 build_host"
  CLUSTER_BUILD_SSH=$(target_host_kv "$CLUSTER_CONF" "$CLUSTER_BUILD_HOST" ssh)
  [ -n "$CLUSTER_BUILD_SSH" ] || die "build_host=$CLUSTER_BUILD_HOST 不在主机表里"
  [ -n "$CLUSTER_ROOT" ] || die "清单缺 remote_root"
  [ -n "$CLUSTER_ENTRY" ] || die "清单缺 entry_health"
  local id role has_core=0
  for id in $(target_host_ids "$CLUSTER_CONF"); do
    role=$(target_host_kv "$CLUSTER_CONF" "$id" role)
    if [ "$role" = "core" ]; then
      has_core=1
    fi
    if [ "$role" = "dev-infra" ]; then
      die "清单混入 role=dev-infra，拒绝发布"
    fi
    [ -n "$(target_host_kv "$CLUSTER_CONF" "$id" restart)" ] || die "[host.$id] 缺 restart"
  done
  [ "$has_core" = 1 ] || die "清单没有 role=core，拒绝发布"
}

cluster_ssh() {
  local spec="$1"
  shift
  ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=20 "$spec" "$@"
}

local_snap() {
  local snap
  snap=$(cd "$REPO" && git stash create || true)
  [ -z "$snap" ] && snap=$(cd "$REPO" && git rev-parse HEAD)
  printf '%s\n' "$snap"
}

local_rev() {
  cd "$REPO" && git rev-parse --short=12 "$(local_snap)"
}

print_release_plan() {
  local rev="$1"
  echo "目标      $CLUSTER_NAME  ($CLUSTER_CONF)"
  echo "build     $CLUSTER_BUILD_HOST  $CLUSTER_BUILD_SSH"
  echo "root      $CLUSTER_ROOT"
  echo "rev       $rev"
  echo "入口探活  $CLUSTER_ENTRY"
  echo "禁区      $CLUSTER_ACCESSORIES"
  echo
  local id role ssh_spec compose restart health_http health_worker
  for id in $(target_host_ids "$CLUSTER_CONF"); do
    role=$(target_host_kv "$CLUSTER_CONF" "$id" role)
    ssh_spec=$(target_host_kv "$CLUSTER_CONF" "$id" ssh)
    compose=$(target_host_kv "$CLUSTER_CONF" "$id" compose)
    restart=$(target_host_kv "$CLUSTER_CONF" "$id" restart)
    health_http=$(target_host_kv "$CLUSTER_CONF" "$id" health_http)
    health_worker=$(target_host_kv "$CLUSTER_CONF" "$id" health_worker)
    echo "[$id] role=$role ssh=$ssh_spec compose=$compose"
    echo "      restart $restart"
    [ -n "$health_http" ] && echo "      health_http $health_http"
    [ -n "$health_worker" ] && echo "      health_worker $health_worker"
  done
}

current_rev() {
  cluster_ssh "$CLUSTER_BUILD_SSH" "cat $CLUSTER_ROOT/apps/current-rev 2>/dev/null" || true
}

previous_rev() {
  cluster_ssh "$CLUSTER_BUILD_SSH" "cat $CLUSTER_ROOT/apps/previous-rev 2>/dev/null" || true
}

acquire_lock() {
  cluster_ssh "$CLUSTER_BUILD_SSH" "mkdir $CLUSTER_ROOT/.release.lock 2>/dev/null || { echo '已有发布在进行' >&2; exit 7; }"
}

release_lock() {
  cluster_ssh "$CLUSTER_BUILD_SSH" "rmdir $CLUSTER_ROOT/.release.lock 2>/dev/null || true"
}

upsert_build_version() {
  local spec="$1" envfile="$2" rev="$3"
  cluster_ssh "$spec" "umask 077; f='$envfile'; [ -f \"\$f\" ] || { echo \"缺少 \$f\" >&2; exit 1; }
    tmp=\$f.tmp
    if grep -q '^CAIRN_BUILD_VERSION=' \"\$f\"; then
      awk -v v='$rev' 'BEGIN{re=\"^CAIRN_BUILD_VERSION=\"} \$0 ~ re { print \"CAIRN_BUILD_VERSION=\" v; next } { print }' \"\$f\" > \"\$tmp\"
    else
      cp \"\$f\" \"\$tmp\"
      printf 'CAIRN_BUILD_VERSION=%s\\n' '$rev' >> \"\$tmp\"
    fi
    mv \"\$tmp\" \"\$f\"
    chmod 640 \"\$f\""
}

switch_current() {
  local rev="$1"
  cluster_ssh "$CLUSTER_BUILD_SSH" "set -euo pipefail
    ROOT='$CLUSTER_ROOT'
    REV='$rev'
    [ -d \"\$ROOT/apps/releases/\$REV/api\" ] || { echo \"找不到产物 \$ROOT/apps/releases/\$REV\" >&2; exit 1; }
    cd \"\$ROOT/apps\"
    mkdir -p releases
    if [ ! -L api ] && [ -d api ]; then
      mkdir -p releases/legacy
      [ -d api ] && [ ! -L api ] && mv api releases/legacy/api
      [ -d worker ] && [ ! -L worker ] && mv worker releases/legacy/worker
      [ -d web ] && [ ! -L web ] && mv web releases/legacy/web
      echo legacy > previous-rev
    elif [ -L api ]; then
      old=\$(readlink api)
      old=\${old#*releases/}
      old=\${old%%/*}
      echo \"\$old\" > previous-rev
    fi
    ln -sfn \"\$ROOT/apps/releases/\$REV/api\" api
    ln -sfn \"\$ROOT/apps/releases/\$REV/worker\" worker
    ln -sfn \"\$ROOT/apps/releases/\$REV/web\" web
    echo \"\$REV\" > current-rev
    chown -h 1000:1000 api worker web 2>/dev/null || true
  "
}

prune_releases() {
  cluster_ssh "$CLUSTER_BUILD_SSH" "set -euo pipefail
    ROOT='$CLUSTER_ROOT/apps/releases'
    CUR=\$(cat $CLUSTER_ROOT/apps/current-rev 2>/dev/null || true)
    PREV=\$(cat $CLUSTER_ROOT/apps/previous-rev 2>/dev/null || true)
    [ -d \"\$ROOT\" ] || exit 0
    cd \"\$ROOT\"
    keep=\$(mktemp)
    { echo \"\$CUR\"; echo \"\$PREV\"; } > \"\$keep\"
    extras=\$(ls -1dt */ 2>/dev/null | sed 's#/\$##' | while read -r dir; do
      grep -qx \"\$dir\" \"\$keep\" && continue
      echo \"\$dir\"
    done)
    extra_keep=\$(printf '%s\n' \"\$extras\" | sed -n '1p')
    printf '%s\n' \"\$extras\" | while read -r extra; do
      [ -n \"\$extra\" ] || continue
      [ \"\$extra\" = \"\$extra_keep\" ] && continue
      echo \"清理旧产物 \$extra\"
      rm -rf \"\$ROOT/\$extra\"
    done
    rm -f \"\$keep\"
  " || true
}

# bind-mount 在 create 时钉 inode；compose restart 不重挂、不重读 env_file。
# 必须 --no-deps --force-recreate，且不得带上 accessories。
bounce_apps() {
  local id ssh_spec compose restart deploydir
  for id in $(target_host_ids "$CLUSTER_CONF"); do
    ssh_spec=$(target_host_kv "$CLUSTER_CONF" "$id" ssh)
    compose=$(target_host_kv "$CLUSTER_CONF" "$id" compose)
    restart=$(target_host_kv "$CLUSTER_CONF" "$id" restart)
    deploydir="$CLUSTER_ROOT/deploy"
    echo "▶ [$id] recreate $restart"
    cluster_ssh "$ssh_spec" "cd '$deploydir' && docker compose -f '$compose' up -d --no-deps --force-recreate $restart"
  done
}

run_migrate() {
  local rev="$1"
  echo "▶ 迁移门禁（失败不切流量）"
  cluster_ssh "$CLUSTER_BUILD_SSH" "set -euo pipefail
    ROOT='$CLUSTER_ROOT'
    REV='$rev'
    IMAGE=\$(docker inspect -f '{{.Config.Image}}' cairn-api)
    docker run --rm --user 1000:1000 --network cairn-net --env-file \"\$ROOT/deploy/.env\" \
      -v \"\$ROOT/apps/releases/\$REV/api:/app\" -w /app \
      \"\$IMAGE\" node node_modules/@cairn/db/dist/bin/migrate-cli.js
  "
}

probe_entry() {
  local want="$1" body version
  body=$(curl -fsS --max-time 8 "$CLUSTER_ENTRY" || true)
  echo "  入口  $CLUSTER_ENTRY  $body"
  [ -n "$body" ] || return 1
  version=$(printf '%s' "$body" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
  v=d.get("version")
  print(v if v else "")
except Exception:
  print("")')
  echo "$body" | grep -qE '"status":"(ok|degraded)"' || return 1
  echo "$body" | grep -q '"database":"up"' || return 1
  [ -z "$want" ] && return 0
  [ "$version" = "$want" ] || { echo "入口发布号 '$version' != '$want'" >&2; return 1; }
}

judge_worker_json() {
  local want="$1"
  python3 -c "
import json,sys
raw=sys.stdin.read().strip().splitlines()
js=raw[-1] if raw else ''
print(js)
d=json.loads(js)
node=d.get('node') or {}
if d.get('status') not in ('ok','degraded'):
  raise SystemExit('worker status 非法')
if node.get('loopAlive') is not True:
  raise SystemExit('loopAlive!=true')
ver=d.get('version') or ''
want='$want'
if want and ver != want:
  raise SystemExit('worker 发布号 %s != %s' % (ver, want))
"
}

health_worker_pairs() {
  printf '%s\n' "$1" | awk '{
    n = split($0, a, /[[:space:]]+/)
    for (i = 1; i <= n; i++) if (a[i] ~ /=/) print a[i]
  }'
}

probe_workers_once() {
  local want="$1" id ssh_spec spec pair url wid failed=0
  for id in $(target_host_ids "$CLUSTER_CONF"); do
    ssh_spec=$(target_host_kv "$CLUSTER_CONF" "$id" ssh)
    spec=$(target_host_kv "$CLUSTER_CONF" "$id" health_worker)
    [ -n "$spec" ] || continue
    while IFS= read -r pair; do
      url=${pair%%=*}
      wid=${pair#*=}
      echo "  worker [$id] $wid  ($url)"
      if ! ssh -o BatchMode=yes -o ConnectTimeout=20 "$ssh_spec" "bash -s -- '$wid'" < "$HERE/lib/probe-worker-node.sh" \
        | judge_worker_json "$want"
      then
        failed=1
      fi
    done <<EOF
$(health_worker_pairs "$spec")
EOF
  done
  return "$failed"
}

wait_probes() {
  local want="$1" i=0 entry_ok=0 workers_ok=0
  echo "▶ 探活"
  while [ "$i" -lt 30 ]; do
    entry_ok=0
    workers_ok=0
    probe_entry "$want" && entry_ok=1
    if [ "$entry_ok" = 1 ]; then
      probe_workers_once "$want" && workers_ok=1
    fi
    if [ "$entry_ok" = 1 ] && [ "$workers_ok" = 1 ]; then
      return 0
    fi
    i=$((i + 1))
    sleep 3
  done
  probe_entry "$want" || return 1
  probe_workers_once "$want" || return 1
}

rollback_to() {
  local rev="$1"
  [ -n "$rev" ] || die "没有可回滚的版本（回滚不回滚数据库）"
  echo "▶ 回拨 current → $rev（不回滚数据库、不重构建）"
  switch_current "$rev"
  local id ssh_spec envfile
  for id in $(target_host_ids "$CLUSTER_CONF"); do
    ssh_spec=$(target_host_kv "$CLUSTER_CONF" "$id" ssh)
    envfile="$CLUSTER_ROOT/deploy/.env"
    upsert_build_version "$ssh_spec" "$envfile" "$rev"
    if [ "$(target_host_kv "$CLUSTER_CONF" "$id" role)" = "executor" ]; then
      cluster_ssh "$ssh_spec" "ln -sfn $CLUSTER_ROOT/apps/releases/$rev/worker $CLUSTER_ROOT/apps/worker"
    fi
  done
  bounce_apps
}

do_release() {
  load_cluster
  local snap rev
  snap=$(local_snap)
  rev=$(cd "$REPO" && git rev-parse --short=12 "$snap")
  print_release_plan "$rev"
  if [ "${CAIRN_DRY_RUN:-0}" = "1" ]; then
    echo
    echo "dry-run：不推源码、不构建、不迁库、不重启、不改远端"
    return 0
  fi
  if [ "${CAIRN_DRAIN:-0}" = "1" ]; then
    echo "▶ --drain 仅占位，本次不等待排空活租约"
  fi
  acquire_lock
  trap release_lock EXIT
  local before_pg
  before_pg=$(cluster_ssh "$CLUSTER_BUILD_SSH" "docker inspect -f '{{.State.StartedAt}}' cairn-pg")
  echo "▶ 推源码"
  CAIRN_PUSH_NEW="$snap" CAIRN_PUSH_SSH="$CLUSTER_BUILD_SSH" CAIRN_PUSH_BUILD="$CLUSTER_ROOT/build" "$HERE/lib/push-src.sh"
  echo "▶ 上传内部脚本"
  cluster_ssh "$CLUSTER_BUILD_SSH" "mkdir -p $CLUSTER_ROOT/lib $CLUSTER_ROOT/deploy"
  scp -q "$HERE/lib/build-apps.sh" "$HERE/lib/sync-apps.sh" "$HERE/lib/probe-worker-node.sh" \
    "$CLUSTER_BUILD_SSH:$CLUSTER_ROOT/lib/"
  scp -q "$HERE/lib/cairn-ctl.sh" "$CLUSTER_BUILD_SSH:$CLUSTER_ROOT/deploy/"
  cluster_ssh "$CLUSTER_BUILD_SSH" "chmod +x $CLUSTER_ROOT/lib/*.sh $CLUSTER_ROOT/deploy/cairn-ctl.sh; rm -f $CLUSTER_ROOT/deploy/nginx/worker-gateway.conf.template"
  echo "▶ 构建 $rev"
  cluster_ssh "$CLUSTER_BUILD_SSH" "CAIRN_CLUSTER_ROOT='$CLUSTER_ROOT' $CLUSTER_ROOT/lib/build-apps.sh '$rev'"
  run_migrate "$rev"
  echo "▶ 切 current（api/worker 同一份，再 web）"
  switch_current "$rev"
  local id ssh_spec envfile
  for id in $(target_host_ids "$CLUSTER_CONF"); do
    ssh_spec=$(target_host_kv "$CLUSTER_CONF" "$id" ssh)
    envfile="$CLUSTER_ROOT/deploy/.env"
    upsert_build_version "$ssh_spec" "$envfile" "$rev"
  done
  echo "▶ 分发 worker 到 executor（机房网 lan_ip，不用 Tailscale 主机名）"
  local exec_hosts="" lan
  for id in $(target_host_ids "$CLUSTER_CONF"); do
    if [ "$(target_host_kv "$CLUSTER_CONF" "$id" role)" = "executor" ]; then
      lan=$(target_host_kv "$CLUSTER_CONF" "$id" lan_ip)
      [ -n "$lan" ] || die "[host.$id] 缺 lan_ip，无法从 build_host 分发"
      exec_hosts="$exec_hosts root@$lan"
    fi
  done
  if [ -n "$exec_hosts" ]; then
    cluster_ssh "$CLUSTER_BUILD_SSH" "CAIRN_CLUSTER_ROOT='$CLUSTER_ROOT' $CLUSTER_ROOT/lib/sync-apps.sh '$rev' $exec_hosts"
  fi
  bounce_apps
  if ! wait_probes "$rev"; then
    echo "探活失败，回拨上一份（不回滚数据库）" >&2
    rollback_to "$(previous_rev)"
    die "release 失败，已回拨上一份"
  fi
  local after_pg
  after_pg=$(cluster_ssh "$CLUSTER_BUILD_SSH" "docker inspect -f '{{.State.StartedAt}}' cairn-pg")
  [ "$before_pg" = "$after_pg" ] || die "cairn-pg 启动时间变了，发布不应碰数据卷容器"
  prune_releases
  cluster_ssh "$CLUSTER_BUILD_SSH" "echo \"$(date -u +%Y-%m-%dT%H:%M:%SZ) $(whoami) $rev\" >> $CLUSTER_ROOT/apps/release.log"
  echo "✅ 已发布 $rev"
}

do_rollback() {
  load_cluster
  local rev="${1:-}"
  if [ -z "$rev" ]; then
    rev=$(previous_rev)
  fi
  [ -n "$rev" ] || die "没有上一份产物可回滚。回滚只拨指针，不回滚数据库。"
  echo "回滚只拨指针并重建应用容器，不回滚数据库。已迁过的破坏性迁移不能靠这条回到旧二进制。"
  acquire_lock
  trap release_lock EXIT
  rollback_to "$rev"
  wait_probes "" || die "回滚后入口或 Worker 不健康"
  echo "✅ 已回拨 $rev"
}

do_cluster_status() {
  load_cluster
  local cur body
  cur=$(current_rev)
  echo "目标     $CLUSTER_NAME"
  echo "current  ${cur:-（尚无 current-rev，还是目录挂载）}"
  echo "previous $(previous_rev)"
  echo "入口     $CLUSTER_ENTRY"
  body=$(curl -fsS --max-time 5 "$CLUSTER_ENTRY" || true)
  if [ -n "$body" ]; then
    echo "         $body"
  else
    echo "         入口不通"
  fi
  echo
  local id ssh_spec compose
  for id in $(target_host_ids "$CLUSTER_CONF"); do
    ssh_spec=$(target_host_kv "$CLUSTER_CONF" "$id" ssh)
    compose=$(target_host_kv "$CLUSTER_CONF" "$id" compose)
    echo "═══ $id $(target_host_kv "$CLUSTER_CONF" "$id" role) ═══"
    cluster_ssh "$ssh_spec" "cd $CLUSTER_ROOT/deploy && docker compose -f $compose ps --format 'table {{.Name}}\t{{.Status}}'"
  done
  echo
  echo "Worker"
  if [ -n "$cur" ]; then
    probe_workers_once "$cur" || probe_workers_once "" || true
  else
    probe_workers_once "" || true
  fi
}

do_migrate_only() {
  load_cluster
  local rev
  rev=$(current_rev)
  [ -n "$rev" ] || die "没有 current-rev，先 release"
  run_migrate "$rev"
}

map_service() {
  case "$1" in
    api) echo cairn-api ;;
    web|nginx) echo cairn-nginx ;;
    *) echo "$1" ;;
  esac
}

host_has_service() {
  local list="$1" name="$2"
  echo " $list " | grep -q " $name "
}

do_restart_named() {
  load_cluster
  local want="${1:?用法: ./deploy/cairn restart <api|worker|nginx|...>}"
  local mapped id ssh_spec compose restart hit=0
  mapped=$(map_service "$want")
  for id in $(target_host_ids "$CLUSTER_CONF"); do
    restart=$(target_host_kv "$CLUSTER_CONF" "$id" restart)
    if [ "$want" = "worker" ] || [ "$want" = "executor" ]; then
      local name
      for name in $restart; do
        echo "$name" | grep -Eq 'executor|scheduler|analyst|maintenance' || continue
        ssh_spec=$(target_host_kv "$CLUSTER_CONF" "$id" ssh)
        compose=$(target_host_kv "$CLUSTER_CONF" "$id" compose)
        echo "▶ [$id] recreate $name"
        cluster_ssh "$ssh_spec" "cd $CLUSTER_ROOT/deploy && docker compose -f $compose up -d --no-deps --force-recreate $name"
        hit=1
      done
      continue
    fi
    host_has_service "$restart" "$mapped" || continue
    ssh_spec=$(target_host_kv "$CLUSTER_CONF" "$id" ssh)
    compose=$(target_host_kv "$CLUSTER_CONF" "$id" compose)
    echo "▶ [$id] recreate $mapped"
    cluster_ssh "$ssh_spec" "cd $CLUSTER_ROOT/deploy && docker compose -f $compose up -d --no-deps --force-recreate $mapped"
    hit=1
  done
  [ "$hit" = 1 ] || die "$want ($mapped) 不在清单 restart 里"
}

do_logs() {
  load_cluster
  local want="${1:-api}" mapped id ssh_spec compose restart hit=0
  mapped=$(map_service "$want")
  for id in $(target_host_ids "$CLUSTER_CONF"); do
    restart=$(target_host_kv "$CLUSTER_CONF" "$id" restart)
    host_has_service "$restart" "$mapped" || continue
    ssh_spec=$(target_host_kv "$CLUSTER_CONF" "$id" ssh)
    compose=$(target_host_kv "$CLUSTER_CONF" "$id" compose)
    echo "═══ $id $mapped ═══"
    cluster_ssh "$ssh_spec" "cd $CLUSTER_ROOT/deploy && docker compose -f $compose logs --tail 120 $mapped"
    hit=1
  done
  [ "$hit" = 1 ] || die "$want ($mapped) 不在清单 restart 里"
}

do_bootstrap() {
  CAIRN_TARGET_FILE="$HERE/targets/${CAIRN_TARGET:-cluster}.conf" "$HERE/lib/ship.sh"
}

do_build_base() {
  load_cluster
  local tag="${1:-}"
  [ -n "$tag" ] || tag=$(cd "$REPO" && git rev-parse --short=12 HEAD)
  echo "底座镜像构建是稀有操作，不进日常 release。"
  CAIRN_PUSH_SSH="$CLUSTER_BUILD_SSH" CAIRN_PUSH_BUILD="$CLUSTER_ROOT/build" "$HERE/lib/push-src.sh"
  cluster_ssh "$CLUSTER_BUILD_SSH" "mkdir -p $CLUSTER_ROOT/lib"
  scp -q "$HERE/lib/build-base.sh" "$CLUSTER_BUILD_SSH:$CLUSTER_ROOT/lib/"
  cluster_ssh "$CLUSTER_BUILD_SSH" "cd $CLUSTER_ROOT/build && bash $CLUSTER_ROOT/lib/build-base.sh $tag"
}
