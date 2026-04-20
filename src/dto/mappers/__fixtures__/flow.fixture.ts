/**
 * Hand-crafted @ory/client Flow payloads (login / registration / recovery /
 * settings / verification) for mapper tests.
 */
import type {
  LoginFlow as OryLoginFlow,
  RecoveryFlow as OryRecoveryFlow,
  RegistrationFlow as OryRegistrationFlow,
  SettingsFlow as OrySettingsFlow,
  VerificationFlow as OryVerificationFlow,
} from '@ory/client';

import { fullyVerifiedOryIdentity } from './identity.fixture';

function baseUi(csrf: string | null) {
  const nodes: Array<Record<string, unknown>> = [];
  if (csrf !== null) {
    nodes.push({
      type: 'input',
      group: 'default',
      attributes: {
        name: 'csrf_token',
        node_type: 'input',
        type: 'hidden',
        value: csrf,
        disabled: false,
      },
      messages: [],
      meta: {},
    });
  }
  nodes.push({
    type: 'input',
    group: 'password',
    attributes: {
      name: 'password',
      node_type: 'input',
      type: 'password',
      disabled: false,
    },
    messages: [],
    meta: {},
  });
  return {
    action: 'http://example.test/submit',
    method: 'POST',
    nodes,
    messages: [{ id: 1010001, text: 'hello', type: 'info' }],
  };
}

export const oryLoginFlow = {
  id: 'login-1',
  type: 'browser',
  expires_at: '2030-01-01T00:00:00.000Z',
  issued_at: '2030-01-01T00:00:00.000Z',
  request_url: 'http://example.test/login',
  state: 'choose_method',
  ui: baseUi('csrf-login'),
} as unknown as OryLoginFlow;

export const oryRegistrationFlow = {
  id: 'reg-1',
  type: 'browser',
  expires_at: '2030-01-01T00:00:00.000Z',
  issued_at: '2030-01-01T00:00:00.000Z',
  request_url: 'http://example.test/register',
  state: 'choose_method',
  ui: baseUi('csrf-reg'),
} as unknown as OryRegistrationFlow;

export const oryRecoveryFlow = {
  id: 'rec-1',
  type: 'browser',
  expires_at: '2030-01-01T00:00:00.000Z',
  issued_at: '2030-01-01T00:00:00.000Z',
  request_url: 'http://example.test/recover',
  state: 'choose_method',
  ui: baseUi('csrf-rec'),
} as unknown as OryRecoveryFlow;

export const orySettingsFlow = {
  id: 'set-1',
  type: 'browser',
  expires_at: '2030-01-01T00:00:00.000Z',
  issued_at: '2030-01-01T00:00:00.000Z',
  request_url: 'http://example.test/settings',
  state: 'show_form',
  identity: fullyVerifiedOryIdentity,
  ui: baseUi('csrf-set'),
} as unknown as OrySettingsFlow;

export const oryVerificationFlow = {
  id: 'ver-1',
  type: 'browser',
  expires_at: '2030-01-01T00:00:00.000Z',
  issued_at: '2030-01-01T00:00:00.000Z',
  request_url: 'http://example.test/verify',
  state: 'choose_method',
  ui: baseUi('csrf-ver'),
} as unknown as OryVerificationFlow;

export const oryLoginFlowNoCsrf = {
  ...oryLoginFlow,
  ui: baseUi(null),
} as unknown as OryLoginFlow;

export const oryLoginFlowMissingExpires = {
  id: 'login-2',
  type: 'browser',
  request_url: 'http://example.test/login',
  state: 'choose_method',
  ui: baseUi('csrf-login'),
} as unknown as OryLoginFlow;
