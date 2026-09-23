import { ContactRef } from './persons.contact';

export type VoiceProfile = {
  vocabulary?: string[];
  tone?: string;
  quirks?: string[];
  sampleTurns?: string[];
};

export type Person = {
  id: string;
  userId: string;
  name: string;
  sourceContactRef: string | null;
  isSelf: boolean;
  voiceProfile: VoiceProfile | null;
};

/**
 * What every reader projects. `sourceContactRef` is deliberately absent: it is
 * an internal join key for contact de-duplication and, being a hash of a real
 * phone number or email, has no reason to leave the server.
 */
export type PublicPerson = Pick<Person, 'id' | 'name' | 'isSelf' | 'voiceProfile'>;

/**
 * Writer input. `sourceContactRef` is a `ContactRef`, not a string, so a raw
 * handle cannot reach the column — the service hashes first. See
 * persons.contact.ts.
 */
export type NewPerson = {
  userId: string;
  name: string;
  sourceContactRef?: ContactRef;
  isSelf?: boolean;
  voiceProfile?: VoiceProfile;
};

export type PersonRelationship = {
  id: string;
  userId: string;
  personAId: string;
  personBId: string;
  relationshipType: string | null;
};
