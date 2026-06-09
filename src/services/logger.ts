export type LogEvent = 'upload' | 'download' | 'delete' | 'list' | 'info' | 'login' | 'login_failed' | 'share' | 'extend' | 'cleanup' | 'health'

export interface LogEntry {
  timestamp: string
  event: LogEvent
  ip: string
  fileId?: string
  fileName?: string
  fileSize?: number
  adminId?: string
  details?: string
}

export function logEntry(entry: LogEntry): void {
  console.log(JSON.stringify(entry))
}

export function logEvent(
  event: LogEvent,
  ip: string,
  extras?: Partial<Omit<LogEntry, 'timestamp' | 'event' | 'ip'>>,
): void {
  logEntry({ timestamp: new Date().toISOString(), event, ip, ...extras })
}
