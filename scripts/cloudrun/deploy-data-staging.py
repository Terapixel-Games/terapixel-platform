#!/usr/bin/env python3
"""Image-only staging release, plus the explicitly approved save/IAP store flags.
Full runtime values stay in process memory; never emit them to logs/artifacts.
"""
import copy
import json
import os
import re
import subprocess
import urllib.request
import urllib.error

PROJECT = 'terapixel-platform-staging'
REGION = 'us-central1'
ACCOUNT = 'github-cloudrun-deployer@terapixel-platform-staging.iam.gserviceaccount.com'
SERVICES = {'identity-gateway': None, 'save-service': 'SAVE_STORE_TYPE', 'iap-service': 'IAP_STORE_TYPE'}

def cloud(*args, region=True):
    command = ['gcloud', *args, '--account='+ACCOUNT, '--project='+PROJECT]
    if region:
        command.append('--region='+REGION)
    return subprocess.check_output(command, text=True).strip()

def describe(service):
    return json.loads(cloud('run', 'services', 'describe', 'terapixel-'+service, '--format=json'))

def policy(service):
    return json.loads(cloud('run', 'services', 'get-iam-policy', 'terapixel-'+service, '--format=json'))

def preserved_config(description, store_flag):
    # Compare the entire runtime spec, template metadata and service annotations.
    # Only image, the approved flag, and gcloud bookkeeping may change.
    data = copy.deepcopy(description)
    data['spec'].pop('traffic', None)  # Traffic is checked explicitly at each phase.
    template = data['spec']['template']
    for container in template['spec']['containers']:
        container.pop('image', None)
        if store_flag:
            container['env'] = [e for e in container.get('env', []) if e['name'] != store_flag]
    annotations = template.get('metadata', {}).get('annotations', {})
    for key in ['run.googleapis.com/client-name', 'run.googleapis.com/client-version']:
        annotations.pop(key, None)
    metadata = template.get('metadata', {})
    metadata.pop('name', None)
    # These generated labels identify a revision rather than security settings.
    labels = metadata.get('labels', {})
    labels.pop('client.knative.dev/nonce', None)
    service_annotations = data['metadata'].get('annotations', {})
    for key in ['run.googleapis.com/client-name', 'run.googleapis.com/client-version',
                'run.googleapis.com/operation-id', 'serving.knative.dev/lastModifier']:
        service_annotations.pop(key, None)
    return {'spec': data['spec'], 'annotations': service_annotations}

def summary(line):
    print(line, flush=True)
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
        stream.write(line+'\n')

def smoke(url, service):
    paths = ['/.well-known/jwks.json', '/v1/web/session'] if service == 'identity-gateway' else ['/healthz']
    codes = []
    for path in paths:
        try:
            with urllib.request.urlopen(url+path, timeout=30) as response:
                code, body = response.status, response.read()
        except urllib.error.HTTPError as error:
            code, body = error.code, error.read()
        if path.endswith('jwks.json'):
            assert code == 200 and isinstance(json.loads(body).get('keys'), list), 'JWKS smoke failed'
        elif path == '/v1/web/session':
            assert code == 403 and json.loads(body)['error']['message'] == 'missing or invalid edge ingress secret', 'edge ingress guard failed'
        else:
            assert code in (200, 404), 'health/access baseline failed'
        codes.append(code)
        summary(f'- {service} {path}: HTTP {code}'+(' (frontend/access baseline only)' if code == 404 else ''))
    return codes

def main():
    assert os.environ.get('GITHUB_REF') == 'refs/heads/main', 'main-only release'
    sha = os.environ['GITHUB_SHA']
    assert re.fullmatch('[a-f0-9]{40}', sha)
    images = {}
    for service in SERVICES:
        image = os.environ[service.upper().replace('-', '_')+'_IMAGE']
        assert re.fullmatch('us-central1-docker.pkg.dev/'+PROJECT+'/terapixel-platform/'+service+r'@sha256:[a-f0-9]{64}', image), 'foreign/unpinned image'
        images[service] = image
    before, policies, baselines, rollback, revisions = {}, {}, {}, {}, {}
    summary('### Targeted data-safety staging release')
    summary('- Main source: `'+sha+'`')
    summary('- No destructive migration. Existing memory test state is disposable; rollback cannot recover it.')
    # Preflight all three targets before any revision or traffic change.
    for service, flag in SERVICES.items():
        before[service] = describe(service)
        policies[service] = policy(service)
        traffic = [t for t in before[service]['status']['traffic'] if t.get('percent', 0)]
        assert len(traffic) == 1 and traffic[0]['percent'] == 100, 'requires one 100% serving revision'
        rollback[service] = traffic[0]['revisionName']
        summary(f'- {service} rollback revision: `{rollback[service]}`')
        baselines[service] = smoke(before[service]['status']['url'], service)
    for service, flag in SERVICES.items():
        args = ['run', 'services', 'update', 'terapixel-'+service, '--image='+images[service],
                '--no-traffic', '--quiet', '--format=value(status.latestCreatedRevisionName)']
        if flag:
            args.append('--update-env-vars='+flag+'=postgres')
        revision = cloud(*args)
        assert re.fullmatch('terapixel-'+service+r'-[a-z0-9-]+', revision)
        revisions[service] = revision
        details = json.loads(cloud('run', 'revisions', 'describe', revision, '--format=json'))
        assert any(c.get('type') == 'Ready' and c.get('status') == 'True' for c in details['status']['conditions']), 'revision not ready'
        assert details['status']['imageDigest'] == images[service], 'revision image mismatch'
        after = describe(service)
        assert preserved_config(before[service], flag) == preserved_config(after, flag), 'runtime/security config drift; traffic unchanged'
        assert policies[service] == policy(service), 'IAM drift; traffic unchanged'
        if flag:
            flags = [e for e in after['spec']['template']['spec']['containers'][0]['env'] if e['name'] == flag]
            assert flags == [{'name': flag, 'value': 'postgres'}], 'store mode mismatch'
        old_traffic = [t for t in after['status']['traffic'] if t.get('percent', 0)]
        assert len(old_traffic) == 1 and old_traffic[0]['revisionName'] == rollback[service], 'unexpected traffic before promotion'
        summary(f'- {service} ready image: `{images[service]}`; revision: `{revision}`')
    # Every image/config must be ready and preserved before any promotion.
    for service, revision in revisions.items():
        cloud('run', 'services', 'update-traffic', 'terapixel-'+service, '--to-revisions='+revision+'=100', '--quiet')
        after = describe(service)
        traffic = [t for t in after['status']['traffic'] if t.get('percent', 0)]
        assert len(traffic) == 1 and traffic[0]['revisionName'] == revision and traffic[0]['percent'] == 100
        assert smoke(after['status']['url'], service) == baselines[service], 'smoke status changed after release'
        assert preserved_config(before[service], SERVICES[service]) == preserved_config(after, SERVICES[service])
        assert policies[service] == policy(service)
        summary(f'- {service}: verified 100% traffic; runtime/security preserved'+('; PostgreSQL enabled' if SERVICES[service] else ''))
    summary('- Live authenticated save/wallet/purchase mutations are NOT covered by these read-only checks.')

if __name__ == '__main__':
    main()
