# Correo de facturación mediante Gmail API

1. Configure en el servidor `GMAIL_OAUTH_REDIRECT_URI` con la URL HTTPS pública exacta de la página `/invoicing-config`. Reinicie el servidor. Conserve sin cambios `INVOICE_ENCRYPTION_KEY`, que cifra los secretos guardados.
2. En Google Cloud cree o seleccione un proyecto y habilite Gmail API. Configure la pantalla de consentimiento de Google Auth Platform, audiencia y datos de la aplicación. Para pruebas externas agregue la cuenta de Gmail como usuario de prueba.
3. Cree un cliente OAuth de tipo aplicación web. En URI de redirección autorizados agregue exactamente el valor de `GMAIL_OAUTH_REDIRECT_URI`. Copie el ID y el secreto del cliente.
4. En Configuración SRI seleccione API de Gmail, escriba el remitente y las credenciales, desactive el envío automático y guarde. Pulse Conectar cuenta de Google y autorice la misma cuenta del remitente, incluyendo el permiso de enviar correo.
5. Active el envío automático, guarde y pruebe la conexión. Envíe una factura autorizada a una dirección de prueba y compruebe el PDF y el XML.

La autorización usa `gmail.send`, `openid` y `email`. El secreto y el token de actualización se guardan cifrados. La prueba comprueba autorización y cuenta, pero no entrega un mensaje. Las aplicaciones externas de Google en modo de prueba tienen autorizaciones que caducan a los siete días; para operación continua revise el estado de publicación y los requisitos de verificación de Google. Los límites de envío de Gmail también aplican.

Si se cambia el remitente, el ID o el secreto del cliente, se debe volver a conectar la cuenta. Si Google revoca el acceso, conecte nuevamente. No comparta secretos ni tokens.
