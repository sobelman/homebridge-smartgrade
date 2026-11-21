/** A site (home) of the user. */
export interface SmartGradeSite {
  id: string | number;
  name?: string;
  city?: string;
  country?: string;
  street?: string;
  [key: string]: unknown;
}

/** A device as returned by GET api/v1/sites/{id}/devices (live switch state). */
export interface SmartGradeDevice {
  id: string;
  name?: string;
  description?: string | null;
  location?: string | null;
  site_id?: string | number;
  site_name?: string;
  product_id?: number | string | null;
  firmware?: string | null;
  is_online?: boolean | null;
  has_current?: boolean | null;
  switch_num?: number | null;
  switch_1?: boolean | null;
  switch_2?: boolean | null;
  switch_3?: boolean | null;
  switch_1_name?: string | null;
  switch_2_name?: string | null;
  switch_3_name?: string | null;
  switch_type?: string | null;
  max_on_min?: number | null;
  timers?: SmartGradeTimer[];
  upgradeNow?: boolean | null;
  createdDate?: string | null;
  [key: string]: unknown;
}

/** Latest power reading (verified shape). No kWh field. */
export interface SmartGradeUsageStats {
  volt?: number | string | null;
  amper?: number | string | null;
  watt?: number | string | null;
  watt2?: number | string | null;
  watt3?: number | string | null;
  powerFactor?: number | string | null;
  signalStrength?: number | string | null;
  createdAt?: string | number | null;
  [key: string]: unknown;
}

/** A timer configured in the vendor app (read-only in this plugin). */
export interface SmartGradeTimer {
  id?: string | number;
  name?: string | null;
  is_enabled?: boolean | null;
  timer_kind?: string | null;
  timer_detail?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** A scheduled action: { ts, switch_N, created_by }. */
export interface SmartGradeAction {
  ts: number | string;
  created_by?: string | null;
  [key: string]: unknown;
}

/** Response of POST api/v1/users/login/code. */
export interface SmartGradeLoginResult {
  jwt: string;
  userId: string | number | null;
}

/** Minimal fetch signature, so tests can inject a mock (no real network). */
export type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{
  status: number;
  ok: boolean;
  text(): Promise<string>;
}>;
