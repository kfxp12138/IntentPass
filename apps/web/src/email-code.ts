/** A successful HTTP/SDK call alone does not prove Privy accepted an OTP request. */
export async function requestEmailCode(send:(email:string)=>Promise<unknown>,email:string):Promise<void>{
  const result=await send(email);
  if(!result||typeof result!=='object'||!('success' in result)||result.success!==true)
    throw new Error('EMAIL_CODE_NOT_ACCEPTED');
}

/** Only fixed messages are shown; provider errors can contain email addresses or tokens. */
export function loginFailureMessage(error:unknown,phase:'send'|'login'|'logout'):string {
  if(error instanceof Error&&error.message==='LOGIN_SWITCH_ACCOUNT_REQUIRED')return 'An account is already signed in. Sign out before using another email. No new code or sign-in request was sent.';
  let code:unknown,status:unknown;
  try{if(error&&typeof error==='object'){code='code'in error?error.code:undefined;status='status'in error?error.status:undefined;}}catch{/* Use a generic message. */}
  if(status===429||code==='too_many_requests')return 'Too many requests. Wait a minute before trying again.';
  if(code==='invalid_origin'||code==='missing_origin')return 'This origin is not allowed by Privy. Check the application’s allowed login origins.';
  if(code==='invalid_captcha')return 'Privy requires an additional challenge that this page cannot complete.';
  if(code==='allowlist_rejected'||code==='signup_disabled')return 'This account is not allowed by the application. Check Privy test-user and signup settings.';
  if(code==='disallowed_login_method')return 'Email sign-in is not enabled. Check the Privy application’s login methods.';
  if(code==='disallowed_plus_email')return 'This application does not allow plus-address email aliases. Use a standard email address.';
  if(code==='user_unsubscribed')return 'Privy has suppressed delivery to this email address. Its delivery status needs to be restored.';
  if(code==='missing_or_invalid_privy_app_id'||code==='missing_or_invalid_privy_client_id')return 'Privy application configuration was rejected. Check the login settings.';
  if(code==='cannot_link_more_of_type')return 'The previous account is still signed in, so Privy treats the new email as an account link. Sign out before signing in to a different account.';
  if(code==='max_accounts_reached')return 'The Privy application has reached its user limit. Check its allowance; changing the email or code will not resolve this.';
  if(code==='max_test_accounts_reached')return 'The application has reached its test-user limit. Check the dashboard configuration rather than repeatedly requesting codes.';
  if(code==='user_does_not_exist')return 'Privy did not find this application user. Check whether first-time signup is enabled. The email does not need a Privy dashboard account.';
  if(code==='token_already_used')return 'This verification credential was already used. Check the current session instead of submitting the same code again.';
  if(code==='account_transfer_required')return 'Privy requires an account-linking issue to be resolved. Check the account configuration; another code will not fix it.';
  if(code==='invalid_data'||code==='invalid_request')return 'Privy rejected the sign-in parameters. The integration needs inspection; this does not establish that the code is wrong.';
  if(code==='invalid_state')return 'The Privy login flow is in an inconsistent state. Check the current session instead of repeatedly submitting codes.';
  if(code==='missing_or_invalid_token')return 'Privy did not accept the session credential. Check the login state; the email is not necessarily invalid.';
  if(phase==='login'&&code==='invalid_credentials')return 'The code is invalid or expired. Use the latest six-digit code.';
  if(phase==='login'&&status===400)return 'Privy rejected the request (HTTP 400). Inspect the integration error; this does not establish that the code is wrong.';
  if(phase==='login'&&status===403)return 'Privy denied access (HTTP 403). Check the application and account configuration instead of trying different emails.';
  if(phase==='login'&&(status===500||status===502||status===503||status===504))return 'Privy could not complete the request. Check again later; this does not establish that the code is wrong.';
  return phase==='send'?'Code delivery was not confirmed. Check the connection before retrying; no successful send has been established.':phase==='login'?'Sign-in was not completed. Check the latest code, connection and application configuration.':'Sign-out was not completed. Please retry.';
}
