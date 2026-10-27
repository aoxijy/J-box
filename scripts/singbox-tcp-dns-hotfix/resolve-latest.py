#!/usr/bin/env python3
"""Freeze one official stable source for every job in a release. Fail closed."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.request


def stable_version(release):
    tag = release.get('tag_name', '')
    if release.get('draft') or release.get('prerelease') or not re.fullmatch(r'v\d+\.\d+\.\d+', tag):
        raise ValueError('Expected an official stable vX.Y.Z release')
    return tag[1:]


def version_tuple(version):
    return tuple(map(int, version.split('.')))


def request(url, authenticated=False):
    headers = {'User-Agent': 'J-Box-kernel-resolver'}
    if authenticated and os.environ.get('GITHUB_TOKEN'):
        headers['Authorization'] = 'Bearer ' + os.environ['GITHUB_TOKEN']
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120)


def main(output):
    here = Path(__file__).resolve().parent
    pinned = (here / 'versions.sh').read_text()
    baseline = re.search(r'SINGBOX_UPSTREAM_VERSION="([\d.]+)"', pinned).group(1)
    go = re.search(r'SINGBOX_GO_VERSION="([\d.]+)"', pinned).group(1)
    with request('https://api.github.com/repos/SagerNet/sing-box/releases/latest', True) as response:
        release = json.load(response)
    version = stable_version(release)
    if version_tuple(version) < version_tuple(baseline):
        raise ValueError('Official latest is older than the repository baseline; refusing downgrade')
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    archive = output / 'source.tar.gz'
    digest = hashlib.sha256()
    with request(f'https://codeload.github.com/SagerNet/sing-box/tar.gz/refs/tags/v{version}') as source, archive.open('wb') as target:
        while chunk := source.read(1024 * 1024):
            target.write(chunk)
            digest.update(chunk)
    checksum = digest.hexdigest()
    (output / 'versions.sh').write_text(
        '# Frozen official stable source for this Actions run. Compatibility gates must pass.\n'
        f'SINGBOX_VERSION="{version}-jbox-tcp2"\n'
        f'SINGBOX_UPSTREAM_VERSION="{version}"\n'
        f'SINGBOX_SOURCE_SHA256="{checksum}"\n'
        f'SINGBOX_GO_VERSION="{go}"\n', encoding='utf-8')
    record = {'upstream': version, 'version': f'{version}-jbox-tcp2',
              'source_sha256': checksum, 'release_url': release['html_url'],
              'compatibility': 'pending; publication requires both architecture builds and all tests'}
    (output / 'resolution.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record, indent=2))


if __name__ == '__main__':
    main(sys.argv[1])
