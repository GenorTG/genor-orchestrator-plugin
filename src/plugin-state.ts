// ═══════════════════════════════════════════════════════════════
//  PLUGIN STATE — Module-level mutable state shared between
//  index.ts and helper modules. Centralizes cross-module state
//  to avoid circular imports and tangled dependencies.
// ═══════════════════════════════════════════════════════════════

/** Total number of tools registered via api.registerTool().
 *  Mutated by register() in index.ts, read by snapshotState and
 *  generateStateFromEvents in legacy-helpers.ts. */
export let _toolCount = 0;

export function incrementToolCount(): number {
  return ++_toolCount;
}

// ═══════════════════════════════════════════════════════════════
//  TOOL METADATA — populated by the registerTool wrapper inside
//  register() and used by the module-level manifest export.
// ═══════════════════════════════════════════════════════════════

/** Populated by the registerTool wrapper inside register().
 *  Used by the module-level manifest export. Inlined to avoid
 *  duplication between TOOL_METADATA and api.registerTool calls. */
export const _collectedToolMeta: Array<{ name: string; label: string; description: string; parameters: any }> = [];

/** Static tool name list for metadata reflection at import time.
 *  openclaw plugins build evaluates the module before register() runs,
 *  so _collectedToolMeta would be empty. This static list ensures
 *  contracts.tools is properly populated in openclaw.plugin.json.
 *  Must be kept in sync with the actual api.registerTool calls in index.ts. */
export const _staticToolNames: string[] = [
  "genorch_workflow_advance_phase",
  "genorch_models_auto_discover",
  "genorch_backlog_add",
  "genorch_backlog_dispatch",
  "genorch_backlog_dispatch_all",
  "genorch_backlog_list",
  "genorch_backlog_update",
  "genorch_models_check_routing",
  "genorch_project_tidy_docs",
  "genorch_session_clear_work",
  "genorch_feature_design",
  "genorch_project_create",
  "genorch_issue_debug",
  "genorch_system_diagnose",
  "genorch_project_sync_docs",
  "genorch_handoff_create",
  "genorch_config_show_routing",
  "genorch_logs_query",
  "genorch_models_list",
  "genorch_project_docs_list",
  "genorch_session_list",
  "genorch_models_recommend",
  "genorch_status",
  "genorch_knowledge_quiz",
  "genorch_project_join",
  "genorch_project_list_active",
  "genorch_adr_log",
  "genorch_session_log",
  "genorch_qa_approve",
  "genorch_qa_reject",
  "genorch_qa_submit",
  "genorch_project_rebuild_state",
  "genorch_session_register",
  "genorch_project_leave",
  "genorch_session_start_work",
  "genorch_test_create_e2e",
  "genorch_test_create_unit",
  "genorch_task_delegate",
  "genorch_project_sync_files",
  "genorch_session_unregister",
  "genorch_verify_pipeline_check",
  "genorch_verify_pipeline_guide",
  "genorch_verify_pipeline_start",
  "genorch_worker_hire",
  "genorch_worker_edit",
  "genorch_worker_fire",
  "genorch_room_create",
  "genorch_room_edit",
  "genorch_room_delete",
  "genorch_task_create",
  "genorch_task_move",
  "genorch_task_assign",
  "genorch_worker_message",
];
