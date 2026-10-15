const { app, nativeImage, Tray } = require('electron')
const path = require('node:path')
app.whenReady().then(() => {
  const directory = path.resolve('resources/branding')
  for (const name of ['icon.png', 'tray.png', 'trayTemplate.png']) {
    const image = nativeImage.createFromPath(path.join(directory, name))
    if (image.isEmpty()) throw new Error(`Empty native image: ${name}`)
    console.log(name, image.getSize())
  }
  const tray = new Tray(nativeImage.createFromPath(path.join(directory, 'tray.png')))
  tray.setToolTip('Ambio branding validation')
  console.log('Tray created:', !tray.isDestroyed())
  tray.destroy()
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
