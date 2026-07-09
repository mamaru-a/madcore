/**
 * Live E2E orchestrator — runs modular suites against madmail.
 *
 *   SERVER_URL=https://… JOIN_URI='https://i.delta.chat/#…' bun run test:live-full
 */
import {
    requireLiveEnv,
    summaryAndExit,
    tryMethod,
    fail,
} from './harness';
import { setupPrimaryAccount, setupSecondaryAccount } from './account';
import { secureJoinPeer, runQrHelpers, runSecureJoinExtras } from './securejoin';
import { runProfileSuite } from './profile';
import { runMessagingSuite } from './messaging';
import { runWebxdcSuite, runLocationSuite, runCallsSuite } from './webxdc-location-calls';
import { runGroupsSuite } from './groups';
import { runStoreChatSuite } from './store-chat';
import { runConfigBackupSuite } from './config-backup';

async function main() {
    const { server, joinUri, joinTimeoutMs } = requireLiveEnv();

    console.log('\n🚀 Full live E2E against madmail (modular suites)');
    console.log(`   Server: ${server}`);
    console.log(`   Join:   ${joinUri.slice(0, 56)}…\n`);

    const primary = await setupPrimaryAccount(server);
    if (!primary) {
        fail('ABORT', 'registration failed');
        summaryAndExit();
        return;
    }
    const { dc, account: a } = primary;

    const joined = await secureJoinPeer(a, joinUri, joinTimeoutMs);
    if (!joined) {
        summaryAndExit();
        return;
    }
    const { contact, contactId, peerEmail } = joined;

    console.log('\n── Profile ──');
    await runProfileSuite(a, contact, peerEmail);

    console.log('\n── Messaging ──');
    await runMessagingSuite(a, contact);

    console.log('\n── Webxdc / location / calls ──');
    await runWebxdcSuite(a, contact, peerEmail);
    await runLocationSuite(a, peerEmail);
    await runCallsSuite(a, contact);

    console.log('\n── Groups / channels ──');
    const b = await setupSecondaryAccount(dc, server);
    await runGroupsSuite(a, b, peerEmail, joinTimeoutMs);

    console.log('\n── Store / chat / contacts ──');
    await runStoreChatSuite(a, peerEmail, contactId);

    console.log('\n── QR helpers ──');
    await runQrHelpers(a, joinUri);

    console.log('\n── Config / backup / relays ──');
    await runConfigBackupSuite(a, server);

    console.log('\n── SecureJoin extras ──');
    await runSecureJoinExtras(a, peerEmail);

    console.log('\n── Teardown ──');
    await tryMethod('disconnect', () => { a.disconnect(); });
    if (b) await tryMethod('B.disconnect', () => { b.disconnect(); });

    await tryMethod('dc.listAccounts', () => `${dc.listAccounts().length}`);
    await tryMethod('dc.findAccountByEmail', () =>
        dc.findAccountByEmail(a.getCredentials().email)?.id);
    await tryMethod('dc.getAccount', () => dc.getAccount(a.id).id);

    summaryAndExit();
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
