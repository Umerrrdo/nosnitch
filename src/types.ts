export type TelemetryDefault = "on" | "off" | "partial" | "unknown";

export interface EnvPair {
  name: string;
  value: string;
  accepted_values?: string[];
}

export interface EnvMethod extends EnvPair {
  type: "env";
  alternatives?: EnvPair[];
  optional?: boolean;
  note?: string;
}

export interface FlagMethod {
  type: "flag";
  flag: string;
  note?: string;
}

export interface ConfigFileMethod {
  type: "config_file";
  path: string;
  key: string;
  value: string;
  note?: string;
}

export interface ManualMethod {
  type: "manual";
  instructions: string;
}

export type DisableMethod = EnvMethod | FlagMethod | ConfigFileMethod | ManualMethod;

export interface AppEntry {
  name: string;
  slug: string;
  images: string[];
  telemetry_default: TelemetryDefault;
  destinations?: string[];
  what_is_sent?: string;
  still_sent?: string;
  disable: DisableMethod[];
  fixed_in?: string;
  sources: string[];
  verified_on: string;
  verified: boolean;
  notes?: string;
}

export interface Database {
  schema_version: number;
  apps: AppEntry[];
}
