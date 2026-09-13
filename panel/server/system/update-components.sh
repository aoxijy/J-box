# Sourced by update.sh after channel, temporary directory and download helpers are ready.
# All URLs come from the same J-Box release; the manifest contains asset names, never URLs.
prepare_component_update() {
  _component_helper="$INSTALL_ROOT/panel/server/system/component-update.mjs"
  _component_node="$INSTALL_ROOT/node/bin/node"
  [ -f "$_component_helper" ] && [ -x "$_component_node" ] || return 1
  if [ -n "$EXPECT_VERSION" ]; then
    _manifest_name="j-box-${EXPECT_VERSION}-linux-${ARCH}-components.json"
    _manifest_base="https://github.com/$REPO/releases/download/$EXPECT_VERSION"
  else
    _manifest_name="j-box-linux-${ARCH}-components.json"
    _manifest_base="https://github.com/$REPO/releases/latest/download"
  fi
  info "读取 J-Box 组件版本清单..."
  # Old releases have only the full installer; retain the existing upgrade path for those.
  if ! fetch_to_file "$(build_url "$_manifest_base/$_manifest_name")" "$TMP_DL/components.json"; then
    warn "未取到组件清单，改用完整安装包升级。"
    return 1
  fi
  check_cancel_and_abort
  LD_LIBRARY_PATH="$INSTALL_ROOT/node/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    "$_component_node" "$_component_helper" plan "$TMP_DL/components.json" "$INSTALL_ROOT" "$ARCH" "$EXPECT_VERSION" \
    > "$TMP_DL/components.plan" || die "组件清单校验失败，现有安装未改动。"
  # Pin the download URL to the version inside the checked manifest (also when latest moved).
  _component_version=$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$TMP_DL/components.json" | head -n 1)
  _component_base="https://github.com/$REPO/releases/download/$_component_version"
  STAGE_DIR="$INSTALL_ROOT/.update-stage.$$"
  safe_rm_rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR" || die "无法创建升级暂存目录。"
  UPDATE_COMPONENTS="panel openwrt"
  while read -r _kind _action _name _hash _size; do
    check_cancel_and_abort
    case "$_kind" in
      app|runtime|kernel|geo) ;;
      *) die "未知更新组件:$_kind" ;;
    esac
    if [ "$_action" = "reuse" ]; then
      info "$_kind 版本及文件校验一致，复用本地文件，不下载。"
      case "$_kind" in
        runtime) ln -s "$INSTALL_ROOT/node" "$STAGE_DIR/node" || die "无法复用 Node。" ;;
        kernel) ln -s "$INSTALL_ROOT/bin" "$STAGE_DIR/bin" || die "无法复用 sing-box。" ;;
        geo)
          mkdir -p "$STAGE_DIR/panel/server/resources"
          cp -pR "$INSTALL_ROOT/panel/server/resources/geodata" "$STAGE_DIR/panel/server/resources/geodata" \
            || die "无法复用 Geo 数据。"
          ;;
        *) die "无法复用程序组件。" ;;
      esac
      continue
    fi
    info "下载 $_kind 更新:$_name"
    download_with_progress "$(build_url "$_component_base/$_name")" "$TMP_DL/$_name" "$_size" \
      || die "下载组件 $_kind 失败。现有安装未改动。"
    check_cancel_and_abort
    # Names and hashes are validated by the local helper; never execute manifest text as shell.
    printf '%s  %s\n' "$_hash" "$_name" > "$TMP_DL/$_name.sha256"
    if command -v sha256sum >/dev/null 2>&1; then
      (cd "$TMP_DL" && sha256sum -c "$_name.sha256" >/dev/null) || die "$_kind SHA256 校验失败。"
    else
      (cd "$TMP_DL" && shasum -a 256 -c "$_name.sha256" >/dev/null) || die "$_kind SHA256 校验失败。"
    fi
    write_status extracting "" "" "正在解包 $_kind"
    tar -xzf "$TMP_DL/$_name" -C "$STAGE_DIR" || die "组件 $_kind 解包失败。"
    rm -f "$TMP_DL/$_name"
    case "$_kind" in
      runtime) UPDATE_COMPONENTS="$UPDATE_COMPONENTS node" ;;
      kernel) UPDATE_COMPONENTS="$UPDATE_COMPONENTS bin" ;;
    esac
  done < "$TMP_DL/components.plan"
  LD_LIBRARY_PATH="$INSTALL_ROOT/node/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    "$_component_node" "$_component_helper" verify "$TMP_DL/components.json" "$STAGE_DIR" \
    || die "组合后的安装包校验失败，现有安装未改动。"
  return 0
}
