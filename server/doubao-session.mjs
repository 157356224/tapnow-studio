// Authentication detection is based on the visible login UI, not on the
// presence of cookies. The user's own login step is never automated.
async function loginDialogVisible(page){
  try{
    const dialogs=page.locator('[role="dialog"],[aria-modal="true"]')
      .filter({hasText:/扫码|二维码|验证码|手机号|登录|注册/});
    if(await dialogs.first().isVisible())return true;
    // Login UI variants may not set role="dialog".
    const tabs=page.getByText(/^(手机号登录|扫码登录|验证码登录|短信登录|扫码注册登录)$/);
    return await tabs.first().isVisible();
  }catch{return false;}
}
export async function requiresWebLogin(page){
  if(await loginDialogVisible(page))return true;
  try{
    await page.getByRole('button',{name:'登录',exact:true}).first()
      .waitFor({state:'visible',timeout:3500});
    return true;
  }catch{return await loginDialogVisible(page);}
}

export async function showWebLogin(page){
  if(await loginDialogVisible(page))return true;
  if(!await requiresWebLogin(page))return false;
  try{
    await page.getByRole('button',{name:'登录',exact:true}).first()
      .click({timeout:5000});
    return true;
  }catch{return false;}
}
