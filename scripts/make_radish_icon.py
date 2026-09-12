#!/usr/bin/env python3
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path('generated-icons')
OUT.mkdir(parents=True, exist_ok=True)
T=(0,0,0,0)
# Yoto-ish palette: no pure black visible, saturated simple shape on transparent bg.
OUTLINE=(45,38,55,255)
RADISH=(238,64,95,255)
RADISH_DARK=(175,42,78,255)
HILITE=(255,194,205,255)
WHITE=(245,238,232,255)
GREEN=(75,190,93,255)
GREEN_DARK=(38,121,67,255)

im=Image.new('RGBA',(16,16),T)
d=ImageDraw.Draw(im)
# leaves, big and readable
for xy,fill in [((6,1,8,4),GREEN),((4,2,6,5),GREEN),((9,2,11,5),GREEN),((5,4,10,5),GREEN_DARK)]:
    d.rectangle(xy, fill=fill)
# round radish bulb silhouette
# outline
for xy in [(4,5,11,12),(3,7,12,10),(5,12,10,13)]:
    d.rectangle(xy, fill=OUTLINE)
# body
d.rectangle((5,5,10,11), fill=RADISH)
d.rectangle((4,7,11,10), fill=RADISH)
d.rectangle((6,11,9,12), fill=RADISH_DARK)
# white root/tip
d.point((7,13), fill=WHITE); d.point((8,13), fill=WHITE); d.point((8,14), fill=WHITE)
# highlight/shadow pixels
d.point((6,6), fill=HILITE); d.point((5,8), fill=HILITE)
d.point((10,10), fill=RADISH_DARK); d.point((9,11), fill=RADISH_DARK)
# soften outline corners transparent to keep bulb roundish
for p in [(4,5),(11,5),(3,7),(12,7),(3,10),(12,10),(5,13),(10,13)]:
    d.point(p,T)
icon=OUT/'04_radish_16.png'
preview=OUT/'04_radish_preview_black_256.png'
im.save(icon)
bg=Image.new('RGBA',(256,256),(0,0,0,255))
bg.alpha_composite(im.resize((256,256), Image.Resampling.NEAREST))
bg.save(preview)
print(icon)
print(preview)
print('colors', len(set(p for p in im.getdata() if p[3]>0)), 'alpha', im.getchannel('A').getextrema())
