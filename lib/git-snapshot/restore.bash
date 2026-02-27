#!/usr/bin/env bash

_git_snapshot_restore_assert_patch_bundle_format() {
  local patch_file="$1"

  if [[ ! -s "${patch_file}" ]]; then
    return 0
  fi

  if ! grep -q '^diff --git ' "${patch_file}"; then
    _git_snapshot_ui_err "Invalid patch bundle format: ${patch_file}"
    return 1
  fi

  return 0
}

_git_snapshot_restore_validate_untracked_tar() {
  local tar_file="$1"
  local entry

  if [[ ! -f "${tar_file}" ]]; then
    return 0
  fi

  if ! tar -tf "${tar_file}" >/dev/null 2>&1; then
    _git_snapshot_ui_err "Invalid untracked tar bundle format: ${tar_file}"
    return 1
  fi

  while IFS= read -r entry; do
    [[ -z "${entry}" ]] && continue

    case "${entry}" in
      /*|..|../*|*/../*|*/..)
        _git_snapshot_ui_err "Unsafe untracked tar entry detected: ${entry}"
        return 1
        ;;
    esac
  done < <(tar -tf "${tar_file}")

  return 0
}

_git_snapshot_restore_single_repo() {
  local repo_abs="$1"
  local repo_bundle_dir="$2"

  git -C "${repo_abs}" reset --hard >/dev/null || return 1
  git -C "${repo_abs}" clean -fd >/dev/null || return 1

  if [[ -s "${repo_bundle_dir}/staged.patch" ]]; then
    _git_snapshot_restore_assert_patch_bundle_format "${repo_bundle_dir}/staged.patch" || return 1
    git -C "${repo_abs}" apply --check --binary --whitespace=nowarn --index "${repo_bundle_dir}/staged.patch" || return 1
    git -C "${repo_abs}" apply --binary --whitespace=nowarn --index "${repo_bundle_dir}/staged.patch" || return 1
  fi

  if [[ -s "${repo_bundle_dir}/unstaged.patch" ]]; then
    _git_snapshot_restore_assert_patch_bundle_format "${repo_bundle_dir}/unstaged.patch" || return 1
    git -C "${repo_abs}" apply --check --binary --whitespace=nowarn "${repo_bundle_dir}/unstaged.patch" || return 1
    git -C "${repo_abs}" apply --binary --whitespace=nowarn "${repo_bundle_dir}/unstaged.patch" || return 1
  fi

  if [[ -f "${repo_bundle_dir}/untracked.tar" ]]; then
    _git_snapshot_restore_validate_untracked_tar "${repo_bundle_dir}/untracked.tar" || return 1
    tar -xf "${repo_bundle_dir}/untracked.tar" -C "${repo_abs}" || return 1
  fi
}

_git_snapshot_restore_sanitize_porcelain_value() {
  local value="$1"

  value="${value//$'\t'/ }"
  value="${value//$'\n'/ }"
  value="${value//$'\r'/ }"
  printf "%s" "${value}"
}

_git_snapshot_restore_hard_failure_row() {
  local repo_path="$1"
  local reason="$2"
  local safe_repo safe_reason

  safe_repo="$(_git_snapshot_restore_sanitize_porcelain_value "${repo_path}")"
  safe_reason="$(_git_snapshot_restore_sanitize_porcelain_value "${reason}")"
  printf "%s\t%s\n" "${safe_repo}" "${safe_reason}"
}

_git_snapshot_restore_count_lines() {
  local input="$1"

  if [[ -z "${input}" ]]; then
    printf "0"
    return 0
  fi

  printf "%s\n" "${input}" | sed '/^$/d' | wc -l | tr -d ' '
}

_git_snapshot_restore_dedup_lines() {
  local input="$1"
  printf "%s\n" "${input}" | sed '/^$/d' | LC_ALL=C sort -u
}

_git_snapshot_restore_list_reject_files() {
  local repo_abs="$1"

  (
    cd "${repo_abs}" || exit 1
    find . -type f -name '*.rej' -print 2>/dev/null | sed 's#^\./##' | LC_ALL=C sort
  )
}

_git_snapshot_restore_new_lines() {
  local before="$1"
  local after="$2"

  comm -13 \
    <(printf "%s\n" "${before}" | sed '/^$/d' | LC_ALL=C sort -u) \
    <(printf "%s\n" "${after}" | sed '/^$/d' | LC_ALL=C sort -u)
}

_git_snapshot_restore_porcelain_emit() {
  local porcelain="${1:-false}"
  local row="$2"

  if [[ "${porcelain}" == "true" ]]; then
    printf "%b\n" "${row}"
  fi
}

_git_snapshot_restore_apply_patch_reject() {
  local repo_abs="$1"
  local patch_file="$2"
  local use_index="$3"

  GSN_RESTORE_PATCH_STATUS="none"
  GSN_RESTORE_PATCH_ERROR=""
  GSN_RESTORE_PATCH_REJECT_FILES=""

  if [[ ! -s "${patch_file}" ]]; then
    return 0
  fi

  if ! _git_snapshot_restore_assert_patch_bundle_format "${patch_file}"; then
    GSN_RESTORE_PATCH_STATUS="fail"
    GSN_RESTORE_PATCH_ERROR="invalid patch bundle format: ${patch_file}"
    return 0
  fi

  local -a check_cmd=(git -C "${repo_abs}" apply --check --binary --whitespace=nowarn)
  local -a apply_cmd=(git -C "${repo_abs}" apply --binary --whitespace=nowarn)
  local -a reject_cmd=(git -C "${repo_abs}" apply --reject --binary --whitespace=nowarn)
  if [[ "${use_index}" == "true" ]]; then
    check_cmd+=(--index)
    apply_cmd+=(--index)
    reject_cmd+=(--index)
  fi
  check_cmd+=("${patch_file}")
  apply_cmd+=("${patch_file}")
  reject_cmd+=("${patch_file}")

  local err_output=""
  if "${check_cmd[@]}" >/dev/null 2>&1; then
    if ! err_output="$("${apply_cmd[@]}" 2>&1 >/dev/null)"; then
      if [[ -z "${err_output}" ]]; then
        err_output="unknown error"
      fi
      GSN_RESTORE_PATCH_STATUS="fail"
      GSN_RESTORE_PATCH_ERROR="apply failed (${err_output})"
      return 0
    fi
    GSN_RESTORE_PATCH_STATUS="ok"
    return 0
  fi

  local before_reject after_reject new_reject reject_rc=0
  before_reject="$(_git_snapshot_restore_list_reject_files "${repo_abs}")"
  set +e
  err_output="$("${reject_cmd[@]}" 2>&1 >/dev/null)"
  reject_rc=$?
  set -e
  after_reject="$(_git_snapshot_restore_list_reject_files "${repo_abs}")"
  new_reject="$(_git_snapshot_restore_new_lines "${before_reject}" "${after_reject}")"
  if [[ -n "${new_reject}" ]]; then
    GSN_RESTORE_PATCH_STATUS="reject"
    GSN_RESTORE_PATCH_REJECT_FILES="${new_reject}"
    return 0
  fi

  if [[ "${reject_rc}" -eq 0 ]]; then
    GSN_RESTORE_PATCH_STATUS="ok"
    return 0
  fi

  if [[ -z "${err_output}" ]]; then
    err_output="unknown error"
  fi
  GSN_RESTORE_PATCH_STATUS="fail"
  GSN_RESTORE_PATCH_ERROR="reject apply failed (${err_output})"
}

_git_snapshot_restore_restore_untracked_reject() {
  local repo_abs="$1"
  local repo_bundle_dir="$2"

  GSN_RESTORE_UNTRACKED_STATUS="none"
  GSN_RESTORE_UNTRACKED_COLLISION_FILES=""
  GSN_RESTORE_UNTRACKED_ERROR=""

  local tar_file="${repo_bundle_dir}/untracked.tar"
  if [[ ! -f "${tar_file}" ]]; then
    return 0
  fi

  if ! _git_snapshot_restore_validate_untracked_tar "${tar_file}"; then
    GSN_RESTORE_UNTRACKED_STATUS="fail"
    GSN_RESTORE_UNTRACKED_ERROR="invalid untracked tar bundle format"
    return 0
  fi

  local collision_files
  collision_files="$(_git_snapshot_inspect_untracked_collisions "${repo_abs}" "${repo_bundle_dir}")"
  if [[ -n "${collision_files}" ]]; then
    GSN_RESTORE_UNTRACKED_STATUS="collision"
    GSN_RESTORE_UNTRACKED_COLLISION_FILES="$(_git_snapshot_restore_dedup_lines "${collision_files}")"
  fi

  local tar_entry err_output
  while IFS= read -r tar_entry; do
    [[ -z "${tar_entry}" ]] && continue
    if [[ -n "${GSN_RESTORE_UNTRACKED_COLLISION_FILES}" ]] && printf "%s\n" "${GSN_RESTORE_UNTRACKED_COLLISION_FILES}" | grep -Fxq -- "${tar_entry}"; then
      continue
    fi

    if ! mkdir -p "$(dirname "${repo_abs}/${tar_entry}")"; then
      GSN_RESTORE_UNTRACKED_STATUS="fail"
      GSN_RESTORE_UNTRACKED_ERROR="failed to create parent directory for ${tar_entry}"
      return 0
    fi

    if ! err_output="$(tar -xf "${tar_file}" -C "${repo_abs}" "${tar_entry}" 2>&1 >/dev/null)"; then
      if [[ -z "${err_output}" ]]; then
        err_output="unknown error"
      fi
      GSN_RESTORE_UNTRACKED_STATUS="fail"
      GSN_RESTORE_UNTRACKED_ERROR="failed to extract ${tar_entry} (${err_output})"
      return 0
    fi
  done < <(tar -tf "${tar_file}")

  if [[ "${GSN_RESTORE_UNTRACKED_STATUS}" != "collision" ]]; then
    GSN_RESTORE_UNTRACKED_STATUS="ok"
  fi
}

_git_snapshot_restore_single_repo_reject() {
  local repo_abs="$1"
  local repo_bundle_dir="$2"
  local rel_path="$3"

  GSN_RESTORE_REPO_STATUS="restored"
  GSN_RESTORE_REPO_FAILURE_REASON=""
  GSN_RESTORE_REPO_STAGED_STATUS="none"
  GSN_RESTORE_REPO_UNSTAGED_STATUS="none"
  GSN_RESTORE_REPO_UNTRACKED_STATUS="none"
  GSN_RESTORE_REPO_REJECT_ROWS=""
  GSN_RESTORE_REPO_COLLISION_ROWS=""

  local err_output=""
  if ! err_output="$(git -C "${repo_abs}" reset --hard 2>&1 >/dev/null)"; then
    if [[ -z "${err_output}" ]]; then
      err_output="unknown error"
    fi
    GSN_RESTORE_REPO_STATUS="failed"
    GSN_RESTORE_REPO_FAILURE_REASON="git reset --hard failed (${err_output})"
    return 0
  fi
  if ! err_output="$(git -C "${repo_abs}" clean -fd 2>&1 >/dev/null)"; then
    if [[ -z "${err_output}" ]]; then
      err_output="unknown error"
    fi
    GSN_RESTORE_REPO_STATUS="failed"
    GSN_RESTORE_REPO_FAILURE_REASON="git clean -fd failed (${err_output})"
    return 0
  fi

  local has_partial="false"
  _git_snapshot_restore_apply_patch_reject "${repo_abs}" "${repo_bundle_dir}/staged.patch" true
  GSN_RESTORE_REPO_STAGED_STATUS="${GSN_RESTORE_PATCH_STATUS}"
  if [[ "${GSN_RESTORE_PATCH_STATUS}" == "fail" ]]; then
    GSN_RESTORE_REPO_STATUS="failed"
    GSN_RESTORE_REPO_FAILURE_REASON="staged patch: ${GSN_RESTORE_PATCH_ERROR}"
    return 0
  fi
  if [[ "${GSN_RESTORE_PATCH_STATUS}" == "reject" ]]; then
    has_partial="true"
    while IFS= read -r rej_file; do
      [[ -z "${rej_file}" ]] && continue
      GSN_RESTORE_REPO_REJECT_ROWS+="${rel_path}"$'\t'"${rej_file}"$'\n'
    done <<< "${GSN_RESTORE_PATCH_REJECT_FILES}"
  fi

  _git_snapshot_restore_apply_patch_reject "${repo_abs}" "${repo_bundle_dir}/unstaged.patch" false
  GSN_RESTORE_REPO_UNSTAGED_STATUS="${GSN_RESTORE_PATCH_STATUS}"
  if [[ "${GSN_RESTORE_PATCH_STATUS}" == "fail" ]]; then
    GSN_RESTORE_REPO_STATUS="failed"
    GSN_RESTORE_REPO_FAILURE_REASON="unstaged patch: ${GSN_RESTORE_PATCH_ERROR}"
    return 0
  fi
  if [[ "${GSN_RESTORE_PATCH_STATUS}" == "reject" ]]; then
    has_partial="true"
    while IFS= read -r rej_file; do
      [[ -z "${rej_file}" ]] && continue
      GSN_RESTORE_REPO_REJECT_ROWS+="${rel_path}"$'\t'"${rej_file}"$'\n'
    done <<< "${GSN_RESTORE_PATCH_REJECT_FILES}"
  fi

  _git_snapshot_restore_restore_untracked_reject "${repo_abs}" "${repo_bundle_dir}"
  GSN_RESTORE_REPO_UNTRACKED_STATUS="${GSN_RESTORE_UNTRACKED_STATUS}"
  if [[ "${GSN_RESTORE_UNTRACKED_STATUS}" == "fail" ]]; then
    GSN_RESTORE_REPO_STATUS="failed"
    GSN_RESTORE_REPO_FAILURE_REASON="untracked restore: ${GSN_RESTORE_UNTRACKED_ERROR}"
    return 0
  fi
  if [[ "${GSN_RESTORE_UNTRACKED_STATUS}" == "collision" ]]; then
    has_partial="true"
    while IFS= read -r collision_file; do
      [[ -z "${collision_file}" ]] && continue
      GSN_RESTORE_REPO_COLLISION_ROWS+="${rel_path}"$'\t'"${collision_file}"$'\n'
    done <<< "${GSN_RESTORE_UNTRACKED_COLLISION_FILES}"
  fi

  if [[ "${has_partial}" == "true" ]]; then
    GSN_RESTORE_REPO_STATUS="partial"
  fi
}

_git_snapshot_restore_collect_status_hash_mismatches() {
  local root_repo="$1"
  local target_snapshot_path="$2"
  local mismatch_rows=""
  local repo_id rel_path _head_expected status_hash_expected repo_abs status_hash_actual reason

  while IFS=$'\t' read -r repo_id rel_path _head_expected status_hash_expected; do
    [[ -z "${repo_id}" ]] && continue
    repo_abs="${root_repo}/${rel_path}"
    status_hash_actual="$(_git_snapshot_status_hash_for_repo "${repo_abs}")"
    if [[ "${status_hash_actual}" != "${status_hash_expected}" ]]; then
      reason="status_hash_mismatch expected=${status_hash_expected} actual=${status_hash_actual}"
      mismatch_rows+="$(_git_snapshot_restore_hard_failure_row "${rel_path}" "${reason}")"$'\n'
    fi
  done < <(_git_snapshot_store_read_repo_entries "${target_snapshot_path}")

  GSN_RESTORE_STATUS_HASH_MISMATCH_ROWS="$(_git_snapshot_restore_dedup_lines "${mismatch_rows}")"
}

_git_snapshot_restore_emit_partial_summary_human() {
  local target_snapshot_id="$1"
  local safety_snapshot_id="$2"
  local repos_total="$3"
  local repos_restored="$4"
  local repos_partial="$5"
  local reject_rows="$6"
  local collision_rows="$7"

  _git_snapshot_ui_warn "Restore completed with unresolved conflicts (reject mode)."
  _git_snapshot_ui_warn "Repos processed=${repos_total}, fully restored=${repos_restored}, partial=${repos_partial}."

  if [[ -n "${reject_rows}" ]]; then
    _git_snapshot_ui_warn "Rejected hunks:"
    local row repo_path file_path
    while IFS=$'\t' read -r repo_path file_path; do
      [[ -z "${repo_path}" ]] && continue
      _git_snapshot_ui_warn "  - ${repo_path}: ${file_path}"
    done <<< "${reject_rows}"
  fi

  if [[ -n "${collision_rows}" ]]; then
    _git_snapshot_ui_warn "Untracked collisions:"
    local row repo_path file_path
    while IFS=$'\t' read -r repo_path file_path; do
      [[ -z "${repo_path}" ]] && continue
      _git_snapshot_ui_warn "  - ${repo_path}: ${file_path}"
    done <<< "${collision_rows}"
  fi

  _git_snapshot_ui_info "Next steps:"
  _git_snapshot_ui_info "  1) Resolve *.rej files and remove them."
  _git_snapshot_ui_info "  2) Resolve untracked-collision files."
  _git_snapshot_ui_info "  3) Run: git-snapshot verify ${target_snapshot_id}"
  if [[ -n "${safety_snapshot_id}" ]]; then
    _git_snapshot_ui_info "To abort and fully revert to pre-restore state:"
    _git_snapshot_ui_info "  git-snapshot restore ${safety_snapshot_id}"
  fi
}

_git_snapshot_restore_with_optional_rollback() {
  local root_repo="$1"
  local target_snapshot_id="$2"
  local skip_safety_snapshot="${3:-false}"
  local porcelain="${4:-false}"

  local target_snapshot_path
  target_snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${target_snapshot_id}")"

  _git_snapshot_store_assert_snapshot_exists "${root_repo}" "${target_snapshot_id}"

  local safety_snapshot_id=""
  if [[ "${skip_safety_snapshot}" != "true" ]]; then
    safety_snapshot_id="$(_git_snapshot_create_internal "${root_repo}" "safety-before-restore-${target_snapshot_id}" false "" "auto")"
    if [[ "${porcelain}" != "true" ]]; then
      _git_snapshot_ui_info "Created safety snapshot: ${safety_snapshot_id}"
    fi
  fi

  local restore_failed=false
  local mismatch_lines=()
  local rel_path head_expected current_head repo_abs repo_bundle_dir status_hash_expected status_hash_actual repo_id human_repo_label
  local repos_processed=0

  # Apply bundles for all repos first. Parent repo status can depend on nested
  # submodule working-tree state, so status-hash verification must run after
  # the full apply pass completes.
  while IFS=$'\t' read -r repo_id rel_path head_expected _status_hash_expected; do
    [[ -z "${repo_id}" ]] && continue
    repos_processed=$((repos_processed + 1))
    repo_abs="${root_repo}/${rel_path}"
    human_repo_label="$(_git_snapshot_ui_human_repo_label "${root_repo}" "${rel_path}")"
    repo_bundle_dir="$(_git_snapshot_store_repo_dir_for_id "${target_snapshot_path}" "${repo_id}")"

    current_head="$(git -C "${repo_abs}" rev-parse HEAD 2>/dev/null || true)"
    if [[ "${current_head}" != "${head_expected}" ]]; then
      if [[ "${porcelain}" == "true" ]]; then
        _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_head\tsnapshot_id=${target_snapshot_id}\trepo=${rel_path}\thead_match=false\tsnapshot_head=${head_expected}\tcurrent_head=${current_head}"
      else
        _git_snapshot_ui_warn "HEAD mismatch for ${human_repo_label}: snapshot=${head_expected}, current=${current_head}; attempting best-effort restore."
      fi
    else
      _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_head\tsnapshot_id=${target_snapshot_id}\trepo=${rel_path}\thead_match=true\tsnapshot_head=${head_expected}\tcurrent_head=${current_head}"
    fi

    if ! _git_snapshot_restore_single_repo "${repo_abs}" "${repo_bundle_dir}"; then
      _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_repo\tsnapshot_id=${target_snapshot_id}\trepo=${rel_path}\tstatus=failed\tmode=rollback"
      if [[ "${porcelain}" != "true" ]]; then
        _git_snapshot_ui_err "Restore failed while applying bundles for repo=${human_repo_label}"
      fi
      restore_failed=true
      break
    fi
    _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_repo\tsnapshot_id=${target_snapshot_id}\trepo=${rel_path}\tstatus=restored\tmode=rollback"
  done < <(_git_snapshot_store_read_repo_entries "${target_snapshot_path}")

  if [[ "${restore_failed}" != "true" ]]; then
    while IFS=$'\t' read -r repo_id rel_path _head_expected status_hash_expected; do
      [[ -z "${repo_id}" ]] && continue
      repo_abs="${root_repo}/${rel_path}"
      human_repo_label="$(_git_snapshot_ui_human_repo_label "${root_repo}" "${rel_path}")"
      status_hash_actual="$(_git_snapshot_status_hash_for_repo "${repo_abs}")"
      if [[ "${status_hash_actual}" != "${status_hash_expected}" ]]; then
        mismatch_lines+=("${human_repo_label}: expected=${status_hash_expected} actual=${status_hash_actual}")
        restore_failed=true
      fi
    done < <(_git_snapshot_store_read_repo_entries "${target_snapshot_path}")
  fi

  if [[ "${restore_failed}" == "true" ]]; then
    for line in "${mismatch_lines[@]:-}"; do
      if [[ -n "${line}" && "${porcelain}" != "true" ]]; then
        _git_snapshot_ui_err "Status hash mismatch: ${line}"
      fi
    done

    if [[ -n "${safety_snapshot_id}" ]]; then
      if [[ "${porcelain}" != "true" ]]; then
        _git_snapshot_ui_warn "Attempting automatic rollback using safety snapshot ${safety_snapshot_id}"
      fi
      _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_rollback\tsnapshot_id=${target_snapshot_id}\tsafety_snapshot_id=${safety_snapshot_id}\tattempted=true"
      if ! _git_snapshot_restore_with_optional_rollback "${root_repo}" "${safety_snapshot_id}" true "${porcelain}"; then
        if [[ "${porcelain}" != "true" ]]; then
          _git_snapshot_ui_err "Rollback failed. Repository may be partially restored."
        fi
        _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_rollback\tsnapshot_id=${target_snapshot_id}\tsafety_snapshot_id=${safety_snapshot_id}\tresult=failed"
        _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_summary\tsnapshot_id=${target_snapshot_id}\tmode=rollback\tresult=failed\trepos_processed=${repos_processed}\texit_code=1\tsafety_snapshot_id=${safety_snapshot_id}"
        return 1
      fi
      if [[ "${porcelain}" != "true" ]]; then
        _git_snapshot_ui_warn "Rollback completed."
      fi
      _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_rollback\tsnapshot_id=${target_snapshot_id}\tsafety_snapshot_id=${safety_snapshot_id}\tresult=completed"
    fi

    _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_summary\tsnapshot_id=${target_snapshot_id}\tmode=rollback\tresult=failed\trepos_processed=${repos_processed}\texit_code=1\tsafety_snapshot_id=${safety_snapshot_id}"
    return 1
  fi

  if [[ "${porcelain}" != "true" ]]; then
    _git_snapshot_ui_info "Restore completed successfully for snapshot ${target_snapshot_id}."
  fi
  _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_summary\tsnapshot_id=${target_snapshot_id}\tmode=rollback\tresult=success\trepos_processed=${repos_processed}\texit_code=0\tsafety_snapshot_id=${safety_snapshot_id}"
}

_git_snapshot_restore_with_reject_mode() {
  local root_repo="$1"
  local target_snapshot_id="$2"
  local porcelain="${3:-false}"

  local target_snapshot_path
  target_snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${target_snapshot_id}")"
  _git_snapshot_store_assert_snapshot_exists "${root_repo}" "${target_snapshot_id}"

  local safety_snapshot_id
  safety_snapshot_id="$(_git_snapshot_create_internal "${root_repo}" "safety-before-restore-${target_snapshot_id}" false "" "auto")"
  if [[ "${porcelain}" != "true" ]]; then
    _git_snapshot_ui_info "Created safety snapshot: ${safety_snapshot_id}"
  fi
  _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_safety\tsnapshot_id=${target_snapshot_id}\tsafety_snapshot_id=${safety_snapshot_id}"

  local repos_total=0
  local repos_restored=0
  local repos_partial=0
  local hard_failures=0
  local reject_rows=""
  local collision_rows=""
  local hard_failure_rows=""

  local repo_id rel_path head_expected _status_hash_expected repo_abs repo_bundle_dir current_head human_repo_label
  while IFS=$'\t' read -r repo_id rel_path head_expected _status_hash_expected; do
    [[ -z "${repo_id}" ]] && continue
    repos_total=$((repos_total + 1))
    repo_abs="${root_repo}/${rel_path}"
    repo_bundle_dir="$(_git_snapshot_store_repo_dir_for_id "${target_snapshot_path}" "${repo_id}")"
    human_repo_label="$(_git_snapshot_ui_human_repo_label "${root_repo}" "${rel_path}")"

    current_head="$(git -C "${repo_abs}" rev-parse HEAD 2>/dev/null || true)"
    if [[ "${current_head}" != "${head_expected}" ]]; then
      if [[ "${porcelain}" != "true" ]]; then
        _git_snapshot_ui_warn "HEAD mismatch for ${human_repo_label}: snapshot=${head_expected}, current=${current_head}; attempting best-effort restore."
      fi
      _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_head\tsnapshot_id=${target_snapshot_id}\trepo=${rel_path}\thead_match=false\tsnapshot_head=${head_expected}\tcurrent_head=${current_head}"
    else
      _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_head\tsnapshot_id=${target_snapshot_id}\trepo=${rel_path}\thead_match=true\tsnapshot_head=${head_expected}\tcurrent_head=${current_head}"
    fi

    _git_snapshot_restore_single_repo_reject "${repo_abs}" "${repo_bundle_dir}" "${rel_path}"
    _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_repo\tsnapshot_id=${target_snapshot_id}\trepo=${rel_path}\tstatus=${GSN_RESTORE_REPO_STATUS}\tstaged=${GSN_RESTORE_REPO_STAGED_STATUS}\tunstaged=${GSN_RESTORE_REPO_UNSTAGED_STATUS}\tuntracked=${GSN_RESTORE_REPO_UNTRACKED_STATUS}\tmode=reject"
    case "${GSN_RESTORE_REPO_STATUS}" in
      restored)
        repos_restored=$((repos_restored + 1))
        ;;
      partial)
        repos_partial=$((repos_partial + 1))
        reject_rows+="${GSN_RESTORE_REPO_REJECT_ROWS}"
        collision_rows+="${GSN_RESTORE_REPO_COLLISION_ROWS}"
        ;;
      failed)
        hard_failures=$((hard_failures + 1))
        hard_failure_rows+="$(_git_snapshot_restore_hard_failure_row "${rel_path}" "${GSN_RESTORE_REPO_FAILURE_REASON}")"$'\n'
        ;;
    esac
  done < <(_git_snapshot_store_read_repo_entries "${target_snapshot_path}")

  reject_rows="$(_git_snapshot_restore_dedup_lines "${reject_rows}")"
  collision_rows="$(_git_snapshot_restore_dedup_lines "${collision_rows}")"
  hard_failure_rows="$(_git_snapshot_restore_dedup_lines "${hard_failure_rows}")"

  if [[ "${hard_failures}" -eq 0 && "${repos_partial}" -eq 0 ]]; then
    _git_snapshot_restore_collect_status_hash_mismatches "${root_repo}" "${target_snapshot_path}"
    if [[ -n "${GSN_RESTORE_STATUS_HASH_MISMATCH_ROWS}" ]]; then
      hard_failures=1
      hard_failure_rows="${GSN_RESTORE_STATUS_HASH_MISMATCH_ROWS}"
      repos_restored=0
    fi
  fi

  local reject_count collision_count
  reject_count="$(_git_snapshot_restore_count_lines "${reject_rows}")"
  collision_count="$(_git_snapshot_restore_count_lines "${collision_rows}")"

  if [[ "${hard_failures}" -gt 0 ]]; then
    if [[ "${porcelain}" != "true" ]]; then
      local row_repo row_reason row_human_repo
      while IFS=$'\t' read -r row_repo row_reason; do
        [[ -z "${row_repo}" ]] && continue
        row_human_repo="$(_git_snapshot_ui_human_repo_label "${root_repo}" "${row_repo}")"
        if [[ -n "${row_reason}" ]]; then
          _git_snapshot_ui_err "Restore failed for ${row_human_repo}: ${row_reason}"
        else
          _git_snapshot_ui_err "Restore failed for ${row_human_repo}"
        fi
      done <<< "${hard_failure_rows}"
      _git_snapshot_ui_warn "Attempting automatic rollback using safety snapshot ${safety_snapshot_id}"
    fi
    _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_rollback\tsnapshot_id=${target_snapshot_id}\tsafety_snapshot_id=${safety_snapshot_id}\tattempted=true"
    if ! _git_snapshot_restore_with_optional_rollback "${root_repo}" "${safety_snapshot_id}" true "${porcelain}"; then
      if [[ "${porcelain}" != "true" ]]; then
        _git_snapshot_ui_err "Rollback failed. Repository may be partially restored."
      fi
      _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_rollback\tsnapshot_id=${target_snapshot_id}\tsafety_snapshot_id=${safety_snapshot_id}\tresult=failed"
      _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_summary\tsnapshot_id=${target_snapshot_id}\tmode=reject\tresult=failed\trepos_total=${repos_total}\trepos_restored=${repos_restored}\trepos_partial=${repos_partial}\thard_failures=${hard_failures}\trejects=${reject_count}\tcollisions=${collision_count}\tsafety_snapshot_id=${safety_snapshot_id}\texit_code=1"
      return 1
    fi
    if [[ "${porcelain}" != "true" ]]; then
      _git_snapshot_ui_warn "Rollback completed."
    fi
    _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_rollback\tsnapshot_id=${target_snapshot_id}\tsafety_snapshot_id=${safety_snapshot_id}\tresult=completed"
    while IFS=$'\t' read -r repo_path reason; do
      [[ -z "${repo_path}" ]] && continue
      _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_hard_failure\tsnapshot_id=${target_snapshot_id}\trepo=$(_git_snapshot_restore_sanitize_porcelain_value "${repo_path}")\treason=$(_git_snapshot_restore_sanitize_porcelain_value "${reason}")"
    done <<< "${hard_failure_rows}"
    _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_summary\tsnapshot_id=${target_snapshot_id}\tmode=reject\tresult=failed\trepos_total=${repos_total}\trepos_restored=${repos_restored}\trepos_partial=${repos_partial}\thard_failures=${hard_failures}\trejects=${reject_count}\tcollisions=${collision_count}\tsafety_snapshot_id=${safety_snapshot_id}\texit_code=1"
    return 1
  fi

  if [[ "${repos_partial}" -gt 0 ]]; then
    if [[ "${porcelain}" != "true" ]]; then
      _git_snapshot_restore_emit_partial_summary_human "${target_snapshot_id}" "${safety_snapshot_id}" "${repos_total}" "${repos_restored}" "${repos_partial}" "${reject_rows}" "${collision_rows}"
    fi

    while IFS=$'\t' read -r repo_path file_path; do
      [[ -z "${repo_path}" ]] && continue
      _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_reject\tsnapshot_id=${target_snapshot_id}\trepo=${repo_path}\tfile=${file_path}"
    done <<< "${reject_rows}"
    while IFS=$'\t' read -r repo_path file_path; do
      [[ -z "${repo_path}" ]] && continue
      _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_collision\tsnapshot_id=${target_snapshot_id}\trepo=${repo_path}\tfile=${file_path}"
    done <<< "${collision_rows}"
    _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_summary\tsnapshot_id=${target_snapshot_id}\tmode=reject\tresult=partial\trepos_total=${repos_total}\trepos_restored=${repos_restored}\trepos_partial=${repos_partial}\thard_failures=0\trejects=${reject_count}\tcollisions=${collision_count}\tsafety_snapshot_id=${safety_snapshot_id}\texit_code=4"
    return 4
  fi

  if [[ "${porcelain}" != "true" ]]; then
    _git_snapshot_ui_info "Restore completed successfully for snapshot ${target_snapshot_id}."
  fi
  _git_snapshot_restore_porcelain_emit "${porcelain}" "restore_summary\tsnapshot_id=${target_snapshot_id}\tmode=reject\tresult=success\trepos_total=${repos_total}\trepos_restored=${repos_restored}\trepos_partial=0\thard_failures=0\trejects=0\tcollisions=0\tsafety_snapshot_id=${safety_snapshot_id}\texit_code=0"
  return 0
}
