# Azure Platform Engineer interview task: test materials
 
This repository contains the application you will deploy as part of Aurora Energy Research's Azure Platform Engineer interview task. The task itself, including the objectives, is described in the brief you received with this link. This README covers only what the application needs from your infrastructure.
 
The application is a small status page. Each time it loads, it checks the things the objectives ask you to build and tells you whether they are working: a secret resolved from Key Vault, a password-less connection to Azure SQL, and (for objective 6) name resolution to private endpoints.
 
**You do not need to write, build or change any application code.** If you believe you need to change it, tell us what and why in your write-up.
 
## Before you start
 
These three checks take a few minutes and can save you hours.
 
### Azure CLI and MFA
 
Azure now requires multifactor authentication for any change made through Azure Resource Manager by a user account, including from the Azure CLI and from Terraform running under your CLI sign-in. Your account must be able to complete MFA, and your Azure CLI must be recent enough to handle the MFA prompt. Microsoft states 2.76 as the minimum; we recommend the latest version.
 
```bash
az version --query '"azure-cli"'
az upgrade
```
 
Azure Cloud Shell always has a current CLI and avoids this entirely. Pipelines are not affected: workload identities do not use MFA.
 
### Can your subscription create Azure SQL in your chosen region?
 
Some subscriptions, particularly free and trial ones, are blocked from creating Azure SQL servers in some regions. `terraform plan` will not catch this; it only fails at apply. Check before you write any code by creating and then deleting an empty server, which costs nothing:
 
```bash
LOCATION=uksouth   # the region you intend to use
az group create -n rg-sql-region-check -l "$LOCATION" -o none
az sql server create -g rg-sql-region-check -n "sql-region-check-$RANDOM" -l "$LOCATION" \
  --enable-ad-only-auth --external-admin-principal-type User \
  --external-admin-name "$(az ad signed-in-user show --query userPrincipalName -o tsv)" \
  --external-admin-sid "$(az ad signed-in-user show --query id -o tsv)" -o none \
  && echo "Azure SQL is available in $LOCATION"
az group delete -n rg-sql-region-check --yes --no-wait
```
 
If it fails with an error saying provisioning is restricted or the location is not accepting new servers, pick another region and try again.
 
### Which Azure SQL database tier?
 
The Azure SQL free offer can't be created with the standard `azurerm` Terraform provider at the versions we have tested. You can use the `azapi` provider for the database, or use a Basic database (about £4 a month, billed hourly). Either is fine; tell us which you chose.
 
## What is in this repository
 
| Path | What it is |
|---|---|
| `app/` | Source code of the application, so you can see what you are running. Node.js, two dependencies (`tedious` for SQL, `@azure/identity` for managed identity tokens). |
| `scripts/package.sh` | How the deployment package is built. You do not need to run it. |
| Releases | The ready-to-deploy package, `aurora-interview-app-v1.0.0.zip`, with a SHA-256 checksum. |
 
Please don't open issues or pull requests here; contact Talent Acquisition instead (see Questions, below).
 
## The deployment package
 
Download `aurora-interview-app-v1.0.0.zip` from this repository's **Releases** page, or directly:
 
```bash
curl -fLO https://github.com/ssw-aer/interview-azure_platform/releases/download/v1.0.0/aurora-interview-app-v1.0.0.zip
curl -fLO https://github.com/ssw-aer/interview-azure_platform/releases/download/v1.0.0/aurora-interview-app-v1.0.0.zip.sha256
sha256sum -c aurora-interview-app-v1.0.0.zip.sha256
```
 
The package already includes its dependencies, so it runs as-is. You can deploy it however you like: by hand, from your pipeline, or from Terraform. A pipeline can download it from the URL above, or you can commit it to your own repository.
 
### Runtime
 
| Setting | Value |
|---|---|
| Operating system | Linux |
| Runtime stack | Node.js 22 LTS (`NODE|22-lts`). Node.js 24 LTS also works if your chosen tooling offers it. |
| Startup command | None needed; the platform runs `npm start`. |
| Build during deployment | Not needed. The package includes its dependencies. |
| Plan | The Free (F1) tier is sufficient for objectives 1 to 4. |
 
## Configuration the application expects
 
| Name | Where | Required | Purpose |
|---|---|---|---|
| `DEMO_SECRET` | App setting | Yes | The value to be resolved from Key Vault. Use a dummy value of your choosing. |
| `SQL_CONNECTION_STRING` | App setting, **or** a connection string of any type with this name | Yes | How the application connects to Azure SQL. |
| `KEY_VAULT_URI` | App setting | Optional | The vault's URI, e.g. `https://<vault-name>.vault.azure.net/`. Only used to include Key Vault in the name resolution check. |
| `AZURE_CLIENT_ID` | App setting | Optional | The client ID of a user-assigned managed identity, if you use one and do not put it in the connection string. |
 
### `DEMO_SECRET`
 
An app setting whose value should come from Key Vault, using App Service's [Key Vault references](https://learn.microsoft.com/azure/app-service/app-service-key-vault-references). Use a dummy value of your choosing.
 
The page never displays the value. It shows its length and the first 12 characters of its SHA-256 hash, which you can compare with your own:
 
```bash
printf '%s' 'your-dummy-value' | sha256sum
```
 
If App Service can't resolve a Key Vault reference, it passes the reference string through to the application unchanged, and the page reports that.
 
### `SQL_CONNECTION_STRING`
 
An ADO.NET-style connection string (`Key=Value;` pairs). The application reads these keys and follows Microsoft.Data.SqlClient's conventions for them, so Microsoft's documentation for that library applies:
 
| Key | Aliases the app also accepts |
|---|---|
| `Server` | `Data Source`, `Address`, `Addr`, `Network Address` |
| `Database` | `Initial Catalog` |
| `Authentication` | — |
| `User Id` | `UID`, `User`, `Username` |
| `Password` | `PWD` |
 
Supported `Authentication` values are `Active Directory Managed Identity`, `Active Directory Default` and, if omitted, SQL authentication. Other keys, such as `Encrypt`, are accepted and ignored; the application always encrypts the connection.
 
Objective 4 asks for no credentials in configuration. The page reports SQL authentication as a concern.
 
## The database user
 
The application's identity needs a user in the application database. No schema, tables, data or role memberships are required: a newly created user can connect, which is all the application does.
 
Connected to the **application database** (not `master`) as a Microsoft Entra administrator of the server, run:
 
```sql
CREATE USER [<identity-name>] FROM EXTERNAL PROVIDER;
```
 
`<identity-name>` is the web app's name for a system-assigned identity, or the user-assigned identity's name.
 
Objective 4 asks you to explain how and by whom this is run, and how you would make it repeatable. That is the part we are interested in; the statement itself is given.
 
## What the page shows
 
| Section | Pass means |
|---|---|
| Header | The app name, region, plan SKU and instance as App Service reports them, and when the page was generated. |
| Secret from Key Vault | `DEMO_SECRET` has a value that is not an unresolved Key Vault reference. |
| Credentials in configuration | The SQL connection string contains no password or SQL user name. |
| Azure SQL connection | The application connected and ran `SELECT USER_NAME(), SUSER_SNAME(), DB_NAME()`. The database user shown should be the one you created. |
| Name resolution | The SQL server's hostname, and the vault's if known, resolve to private addresses. Public addresses are expected until objective 6. |
 
When a check fails, the page shows the error and, where it can, a likely cause. The likely causes are suggestions based on the error text, not a diagnosis.
 
The first request after the database has been idle can take up to a minute while a serverless database resumes. Refresh once before investigating anything else.
 
### Endpoints
 
| Path | Returns |
|---|---|
| `/` | The status page. |
| `/api/status` | The same checks as JSON. |
| `/healthz` | `200 ok` while the application is serving requests. It does not run the checks. |
 
## Running it on your own machine (optional)
 
You do not need to, but it can help with diagnosing the SQL side. You will need Node.js 22 or later, and `npm ci` in `app/` to install dependencies (or use the release package). Sign in with `az login` as the server's Microsoft Entra administrator, or as a user who has a database user in the application database, make sure the server's firewall allows your IP address, then:
 
```bash
export SQL_CONNECTION_STRING='<your connection string, using Active Directory Default>'
export DEMO_SECRET='anything'
npm start
```
 
`Active Directory Default` picks up your `az login` session.
 
The page is served at `http://localhost:8080`.
 
## Questions
 
If something in these materials looks wrong, or the application behaves in a way this README does not explain, contact the team from Aurora Talent Acquisition that you've been working with up until now. We would rather you asked than lost time.
 