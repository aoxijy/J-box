export const planLatencyTests = (groups, chatgptGroupName = 'CHATGPT自动') => {
  const chatgpt = groups.find((group) => group.name === chatgptGroupName)
  const chatgptNodes = new Set(chatgpt?.members || [])
  const byUrl = new Map()

  for (const group of groups) {
    const url = String(group.url || '').trim()
    if (!url) continue
    let bucket = byUrl.get(url)
    if (!bucket) {
      bucket = { url, groups: [], nodes: new Set() }
      byUrl.set(url, bucket)
    }
    bucket.groups.push(group.name)
    for (const node of group.members || []) {
      if (group.name !== chatgptGroupName && chatgptNodes.has(node)) continue
      bucket.nodes.add(node)
    }
  }

  return [...byUrl.values()].map(({ url, groups: names, nodes }) => ({ url, groups: names, nodes: [...nodes] }))
}
