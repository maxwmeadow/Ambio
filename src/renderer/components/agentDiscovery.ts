/** Bound IPC discovery and handle synchronous bridge failures like rejections. */
export function discoveryRequest<T>(load: () => Promise<T>, timeout = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Discovery timed out.')), timeout)
    Promise.resolve().then(load).then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
