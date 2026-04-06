import os
import json

# Folder media
folder = os.path.dirname(__file__)

# Ekstensi media yang didukung
media_exts = {'.jpg', '.jpeg', '.png', '.webp', '.mp4', '.webm', '.mov'}

files = [f for f in os.listdir(folder) if os.path.splitext(f)[1].lower() in media_exts]

with open(os.path.join(folder, 'media.json'), 'w', encoding='utf-8') as fp:
    json.dump(files, fp, ensure_ascii=False, indent=2)

print(f"{len(files)} media files written to media.json")
