import { app, nativeImage } from 'electron'
import { join } from 'path'

/** Assets live outside asar so native OS icon APIs can load them in releases. */
export function brandImage(name: string) {
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const image = nativeImage.createFromPath(join(root, 'branding', name))
  if (image.isEmpty()) throw new Error(`Ambio brand image is missing: ${name}`)
  return image
}
