export interface ServiceDefinition {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  healthCheckUrl: string;
  healthCheckTimeoutMs: number;
}

export interface ServiceHandle {
  name: string;
  pid?: number;
  containerId?: string;
}

export interface IServiceStrategy {
  start(service: ServiceDefinition): Promise<ServiceHandle>;
  stop(handle: ServiceHandle): Promise<void>;
  restart(handle: ServiceHandle, service: ServiceDefinition): Promise<ServiceHandle>;
  isRunning(handle: ServiceHandle): Promise<boolean>;
  getLogs(handle: ServiceHandle, lines?: number): Promise<string[]>;
}
