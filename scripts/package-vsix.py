"""Package the existing build as a VSIX using only the Python standard library."""
import json
from pathlib import Path
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape, quoteattr
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
package = json.loads((root / 'package.json').read_text())
files = ['package.json', 'README.md', 'LICENSE', 'LICENSE-MIT', 'THIRD_PARTY_NOTICES.md', 'dist/extension.js',
         'dist/webview.js', 'media/main.css', 'media/icon.svg']
for name in files:
    if not (root / name).is_file():
        raise SystemExit(f'Missing {name}. Build before packaging.')
q = quoteattr
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata>
<Identity Language="en-US" Id={q(package['name'])} Version={q(package['version'])} Publisher={q(package['publisher'])}/>
<DisplayName>{escape(package['displayName'])}</DisplayName>
<Description xml:space="preserve">{escape(package['description'])}</Description>
<Categories>{escape(','.join(package['categories']))}</Categories>
<Properties>
<Property Id="Microsoft.VisualStudio.Code.Engine" Value={q(package['engines']['vscode'])}/>
<Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="vscode.git"/>
<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
<Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true"/>
<Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true"/>
</Properties><License>extension/LICENSE-MIT</License>
</Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets>
<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE-MIT" Addressable="true"/>
</Assets></PackageManifest>'''
content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="json" ContentType="application/json"/>
<Default Extension="vsixmanifest" ContentType="text/xml"/>
<Default Extension="js" ContentType="application/javascript"/>
<Default Extension="css" ContentType="text/css"/>
<Default Extension="svg" ContentType="image/svg+xml"/>
<Default Extension="md" ContentType="text/markdown"/>
<Override PartName="/extension/LICENSE" ContentType="text/plain"/>
<Override PartName="/extension/LICENSE-MIT" ContentType="text/plain"/>
</Types>'''
ET.fromstring(manifest)
ET.fromstring(content_types)
output = root / f"{package['name']}-{package['version']}.vsix"
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    archive.writestr('extension.vsixmanifest', manifest)
    archive.writestr('[Content_Types].xml', content_types)
    for name in files:
        archive.write(root / name, 'extension/' + name)
with ZipFile(output) as archive:
    assert archive.testzip() is None
    assert 'extension/' + package['main'].removeprefix('./') in archive.namelist()
print(f'Created and checked {output.name}: {output.stat().st_size:,} bytes')
