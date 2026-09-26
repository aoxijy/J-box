export type LatencyTestGroup = { name: string; url: string; members: string[] }
export type LatencyTestBatch = { url: string; groups: string[]; nodes: string[] }
export function planLatencyTests(groups: LatencyTestGroup[], chatgptGroupName?: string): LatencyTestBatch[]
