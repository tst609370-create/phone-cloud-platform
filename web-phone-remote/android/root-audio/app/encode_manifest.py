"""Text AndroidManifest.xml -> Android binary XML (no aapt available here)."""
import sys

import pyaxml
from lxml import etree

root = etree.parse(sys.argv[1]).getroot()
axml = pyaxml.AXML()
axml.from_xml(root)
axml.compute()
with open(sys.argv[2], 'wb') as out:
    out.write(axml.pack())
