// ═══════════════════════════════════════════════════════════════
//  WORKFLOW PHASES — Analyze → Plan → Document → Work → Log → Finish
// ═══════════════════════════════════════════════════════════════

export type WorkflowPhase = "analyze" | "plan" | "document" | "work" | "log" | "finish";

export interface PhaseEntry {
  phase: WorkflowPhase;
  enteredAt: string;
  completedAt?: string;
  skipped?: boolean;
}

export interface QAResult {
  passed: boolean;
  notes: string;
  attemptedAt: string;
}

export const WORKFLOW_ORDER: WorkflowPhase[] = ["analyze", "plan", "document", "work", "log", "finish"];

export class WorkflowTracker {
  enabled: boolean = false;
  currentPhase: WorkflowPhase = "analyze";
  phaseHistory: PhaseEntry[] = [];
  currentPhaseStartedAt: number = Date.now();
  qaRetries: number = 0;
  qaMaxRetries: number = 3;
  qaResults: QAResult[] = [];
  isQARunning: boolean = false;
  includeQa: boolean = false;
  autoCommit: boolean = false;
  skipPhases: WorkflowPhase[] = [];

  reset(projectWorkflowConfig?: { enabled: boolean; include_qa?: boolean; auto_commit?: boolean; qa_retries?: number; skip_phases?: string[] }): void {
    this.enabled = projectWorkflowConfig?.enabled ?? false;
    this.includeQa = projectWorkflowConfig?.include_qa ?? false;
    this.currentPhase = "analyze";
    this.phaseHistory = [];
    this.currentPhaseStartedAt = Date.now();
    this.qaRetries = 0;
    this.qaResults = [];
    this.isQARunning = false;
    this.autoCommit = projectWorkflowConfig?.auto_commit ?? false;
    this.skipPhases = (projectWorkflowConfig?.skip_phases ?? []).filter((p): p is WorkflowPhase => WORKFLOW_ORDER.includes(p as any)) as WorkflowPhase[];
    this.qaMaxRetries = projectWorkflowConfig?.qa_retries ?? 3;
    this.enterPhase("analyze");
  }

  enterPhase(phase: WorkflowPhase): void {
    this.currentPhase = phase;
    this.currentPhaseStartedAt = Date.now();
    const existing = this.phaseHistory.find(p => p.phase === phase);
    if (existing) {
      existing.enteredAt = new Date().toISOString();
      existing.completedAt = undefined;
    } else {
      this.phaseHistory.push({ phase, enteredAt: new Date().toISOString() });
    }
  }

  completePhase(phase: WorkflowPhase, skipped?: boolean): void {
    const entry = this.phaseHistory.find(p => p.phase === phase);
    if (entry) {
      entry.completedAt = new Date().toISOString();
      entry.skipped = skipped ?? false;
    }
  }

  nextPhase(): WorkflowPhase | null {
    const idx = WORKFLOW_ORDER.indexOf(this.currentPhase);
    if (idx < 0 || idx >= WORKFLOW_ORDER.length - 1) return null;
    // Skip configured phases
    for (let i = idx + 1; i < WORKFLOW_ORDER.length; i++) {
      if (!this.skipPhases.includes(WORKFLOW_ORDER[i])) {
        return WORKFLOW_ORDER[i];
      }
    }
    return null;
  }

  advance(): WorkflowPhase | null {
    this.completePhase(this.currentPhase);
    const next = this.nextPhase();
    if (next) this.enterPhase(next);
    return next;
  }

  canTransitionTo(target: WorkflowPhase): boolean {
    if (!this.enabled) return true;
    const currentIdx = WORKFLOW_ORDER.indexOf(this.currentPhase);
    const targetIdx = WORKFLOW_ORDER.indexOf(target);
    if (currentIdx < 0 || targetIdx < 0) return true;
    // Allow transitions forward or to same phase (re-entry ok)
    return targetIdx >= currentIdx;
  }

  getPhaseElapsed(): string {
    const elapsed = Date.now() - this.currentPhaseStartedAt;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  getProgress(): string {
    const completed = this.phaseHistory.filter(p => p.completedAt).length;
    const total = WORKFLOW_ORDER.filter(p => !this.skipPhases.includes(p)).length;
    return `${completed}/${total}`;
  }

  toJSON(): Record<string, any> {
    return {
      enabled: this.enabled,
      current_phase: this.currentPhase,
      phase_history: this.phaseHistory,
      phase_elapsed: this.getPhaseElapsed(),
      progress: this.getProgress(),
      qa_retries: this.qaRetries,
      qa_max_retries: this.qaMaxRetries,
      is_qa_running: this.isQARunning,
      auto_commit: this.autoCommit,
      skip_phases: this.skipPhases,
    };
  }
}
