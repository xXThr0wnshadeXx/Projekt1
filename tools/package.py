from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
root=Path(__file__).resolve().parents[1]
dist=root/'dist'
dist.mkdir(exist_ok=True)
files=['manifest.json','index.html','setup.html','map.html','styles.css','README.md']+[str(p.relative_to(root)) for p in sorted((root/'src').glob('*.js'))]
manifest=json.loads((root/'manifest.json').read_text())
assert manifest['host_permissions']==['https://www.linkedin.com/*']
with ZipFile(dist/'orbit-network-mapper.zip','w',ZIP_DEFLATED) as z:
    for name in files:z.write(root/name,'orbit-network-mapper/'+name)
print(dist/'orbit-network-mapper.zip')
