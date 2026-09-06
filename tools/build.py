from pathlib import Path
from shutil import copy2, rmtree
import subprocess
import json

root=Path(__file__).resolve().parents[1]
subprocess.run(['node','--check',str(root/'src/app.js')],check=True)
subprocess.run(['python3',str(root/'tools/package.py')],check=True)
out=root/'out'
if out.exists():rmtree(out)
(out/'src').mkdir(parents=True)
(out/'downloads').mkdir()
for name in ['index.html','setup.html','map.html','styles.css']:copy2(root/name,out/name)
for name in ['app.js','core.js','graph.js','companion.js','library.js','onboarding.js','workspace.js','filters.js']:copy2(root/'src'/name,out/'src'/name)
copy2(root/'dist/orbit-network-mapper.zip',out/'downloads/orbit-network-mapper.zip')
assert (out/'index.html').is_file()
assert json.loads((root/'.openai/hosting.json').read_text())['d1']=='DB'
print('Static app and Chrome companion built in out/.')

import base64, mimetypes
assets={}
for file in out.rglob('*'):
    if file.is_file():
        binary=file.suffix=='.zip'
        assets['/'+file.relative_to(out).as_posix()]={'body':base64.b64encode(file.read_bytes()).decode() if binary else file.read_text(),'binary':binary,'type':mimetypes.guess_type(file.name)[0] or 'application/octet-stream'}
(root/'.build').mkdir(exist_ok=True)
(root/'.build/assets.js').write_text('export default '+json.dumps(assets)+';')
subprocess.run(['npx','vite','build'],cwd=root,check=True)
