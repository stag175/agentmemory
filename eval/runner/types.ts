export interface Session {
  id: string;
  timestamp?: string;
  content: string;
}

export interface Question {
  id: string;
  type: string;
  taskCategory?: string;
  taskTags?: string[];
  question: string;
  answer?: string;
  goldSessionIds: string[];
  haystack: Session[];
}

export interface RankedDoc {
  sessionId: string;
  score: number;
}

export interface Adapter<State = unknown> {
  name: string;
  init(sessions: Session[], config?: Record<string, unknown>): Promise<State>;
  query(q: string, state: State, k: number): Promise<RankedDoc[]>;
  teardown?(state: State): Promise<void>;
}

export interface BenchmarkAdapterDescriptor<State = unknown> {
  name: string;
  backend: string;
  requiresApiKey: boolean;
  apiKeyEnv?: string;
  defaultEnabled?: boolean;
  availability?: {
    status: "available" | "unavailable";
    reason?: string;
    optionalExecutable?: string;
    optionalConfigEnv?: string[];
  };
  adapter: Adapter<State>;
}

export interface ScoreRow {
  questionId: string;
  questionType: string;
  adapter: string;
  k: number;
  precisionAtK: number;
  recallAtK: number;
  hit: boolean;
  topGoldRank: number | null;
  latencyMs: number;
}
