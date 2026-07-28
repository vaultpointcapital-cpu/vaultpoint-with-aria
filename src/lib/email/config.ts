/**
 * The one place every outgoing email's from/reply-to address is defined.
 * No route or template should hardcode an address of its own — a
 * mismatched or unbranded "from" is exactly the kind of thing that gets
 * a whole domain flagged as spam once real users start relying on these
 * emails.
 *
 * no-reply@ for FROM: nobody should reply to an automated verification
 * or welcome email expecting a response. Real replies go to
 * support@, both because that's where the org actually reads mail and
 * because "reply-to" (not "from") is the correct header for that — it
 * keeps the sending domain's own reputation tied to a single, consistent
 * from-address, which registrar/deliverability tools evaluate.
 */
export const EMAIL_FROM = 'VaultPoint <no-reply@vaultpoint.name.ng>';
export const EMAIL_REPLY_TO = 'support@vaultpoint.name.ng';
