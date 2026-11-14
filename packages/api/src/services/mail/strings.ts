/**
 * The words of every mail core sends, per language (docs/email-invitations.md,
 * "Mail language"). A sentence that names someone or something takes the name as
 * an argument, so `templates.ts` calls it twice: with raw values for the text
 * part, and with escaped, bolded ones for the HTML part. `es` is typed as the
 * shape of `en`, so a sentence missing from one language fails the typecheck.
 */
import type { PreferenceLang } from '@nicotind/core';

const en = {
  months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  roles: { admin: 'admin', refiner: 'refiner', listener: 'listener', user: 'user' },
  minutes: (n: string) => (n === '1' ? '1 minute' : `${n} minutes`),
  hours: (n: string) => (n === '1' ? '1 hour' : `${n} hours`),
  hi: (name: string) => `Hi ${name},`,
  orOpen: 'Or open this link:',
  footer: (server: string) => `Sent by ${server}, a NicotinD music server.`,
  test: {
    subject: (server: string) => `Test email from ${server}`,
    intro: (server: string) => `This is a test email from your NicotinD server ${server}.`,
    works: 'If you can read this, email delivery works.',
    linksTo: 'Links in invites and password resets will point to:',
    button: 'Open your server',
    check: 'Open it to check that it reaches your server from where you are.',
  },
  invite: {
    subject: (inviter: string, server: string) => `${inviter} invited you to ${server}`,
    intro: (inviter: string, server: string, role: string) =>
      `${inviter} invited you to their NicotinD music server ${server} as a ${role}.`,
    choose: 'Open this link to choose a username and password:',
    button: 'Accept the invite',
    expiry: (when: string) => `The link works once and expires on ${when}.`,
    keepsEmail: 'Your account will use this email address, so you can reset your password later.',
    ignore: "If you weren't expecting this, you can ignore it.",
  },
  verify: {
    subject: (server: string) => `Confirm your email for ${server}`,
    intro: (server: string) =>
      `Confirm this address for your account on the NicotinD server ${server}.`,
    button: 'Confirm my email',
    expiry:
      'The link works once and expires in 24 hours. Once confirmed, password reset links can be sent here.',
    ignore: "If you didn't ask for this, ignore it — nothing changes until the link is opened.",
    assignedIntro: (admin: string, server: string) =>
      `${admin} added this address to your account on the NicotinD server ${server}. Confirm it's yours:`,
    assignedIgnore:
      "If you don't have an account there, ignore this email — nothing changes until the link is opened.",
  },
  reset: {
    subject: (server: string) => `Reset your password for ${server}`,
    intro: (server: string) =>
      `Someone asked to reset the password of your account on the NicotinD server ${server}.`,
    choose: 'Open this link to choose a new one:',
    button: 'Choose a new password',
    expiry: (within: string) =>
      `The link works once and expires in ${within}. Setting a new password signs you out everywhere else.`,
    ignore: "If it wasn't you, ignore this email — your password stays as it is.",
  },
  changed: {
    subject: (server: string) => `Your password for ${server} was changed`,
    intro: (server: string, when: string) =>
      `The password of your account on the NicotinD server ${server} was changed on ${when}.`,
    signedOut: 'Every other device was signed out.',
    notYou: "If this wasn't you, contact your server admin right away.",
  },
};

export type MailStrings = typeof en;

const es: MailStrings = {
  months: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
  roles: { admin: 'administrador', refiner: 'curador', listener: 'oyente', user: 'usuario' },
  minutes: (n) => (n === '1' ? '1 minuto' : `${n} minutos`),
  hours: (n) => (n === '1' ? '1 hora' : `${n} horas`),
  hi: (name) => `Hola, ${name}:`,
  orOpen: 'O abre este enlace:',
  footer: (server) => `Enviado por ${server}, un servidor de música NicotinD.`,
  test: {
    subject: (server) => `Correo de prueba de ${server}`,
    intro: (server) => `Este es un correo de prueba de tu servidor NicotinD ${server}.`,
    works: 'Si puedes leerlo, el envío de correo funciona.',
    linksTo: 'Los enlaces de las invitaciones y los restablecimientos de contraseña apuntarán a:',
    button: 'Abrir tu servidor',
    check: 'Ábrelo para comprobar que llega a tu servidor desde donde estás.',
  },
  invite: {
    subject: (inviter, server) => `${inviter} te invitó a ${server}`,
    intro: (inviter, server, role) =>
      `${inviter} te invitó a su servidor de música NicotinD ${server} como ${role}.`,
    choose: 'Abre este enlace para elegir un usuario y una contraseña:',
    button: 'Aceptar la invitación',
    expiry: (when) => `El enlace funciona una sola vez y vence el ${when}.`,
    keepsEmail:
      'Tu cuenta usará esta dirección de correo, así podrás restablecer tu contraseña más adelante.',
    ignore: 'Si no esperabas este correo, puedes ignorarlo.',
  },
  verify: {
    subject: (server) => `Confirma tu correo para ${server}`,
    intro: (server) => `Confirma esta dirección para tu cuenta en el servidor NicotinD ${server}.`,
    button: 'Confirmar mi correo',
    expiry:
      'El enlace funciona una sola vez y vence en 24 horas. Una vez confirmada, aquí podrán llegarte los enlaces para restablecer la contraseña.',
    ignore: 'Si no lo pediste, ignóralo: nada cambia hasta que se abra el enlace.',
    assignedIntro: (admin, server) =>
      `${admin} agregó esta dirección a tu cuenta en el servidor NicotinD ${server}. Confirma que es tuya:`,
    assignedIgnore:
      'Si no tienes una cuenta allí, ignora este correo: nada cambia hasta que se abra el enlace.',
  },
  reset: {
    subject: (server) => `Restablece tu contraseña de ${server}`,
    intro: (server) =>
      `Alguien pidió restablecer la contraseña de tu cuenta en el servidor NicotinD ${server}.`,
    choose: 'Abre este enlace para elegir una nueva:',
    button: 'Elegir una contraseña nueva',
    expiry: (within) =>
      `El enlace funciona una sola vez y vence en ${within}. Al elegir una contraseña nueva se cierran tus otras sesiones.`,
    ignore: 'Si no fuiste tú, ignora este correo: tu contraseña sigue igual.',
  },
  changed: {
    subject: (server) => `Se cambió tu contraseña de ${server}`,
    intro: (server, when) =>
      `La contraseña de tu cuenta en el servidor NicotinD ${server} se cambió el ${when}.`,
    signedOut: 'Se cerró la sesión en todos los demás dispositivos.',
    notYou: 'Si no fuiste tú, avisa enseguida al administrador de tu servidor.',
  },
};

export const MAIL_STRINGS: Record<PreferenceLang, MailStrings> = { en, es };
