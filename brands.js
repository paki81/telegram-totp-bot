'use strict';

// Loghi brand (simple-icons, serviti in locale)
// [keyword nel nome/issuer, slug simple-icons, colore brand]
const BRANDS = [
  ['amazon', 'amazon', '#FF9900'], ['aws', 'amazon', '#FF9900'],
  ['netflix', 'netflix', '#E50914'], ['google', 'google', '#4285F4'],
  ['gmail', 'google', '#4285F4'], ['github', 'github', '#181717'],
  ['gitlab', 'gitlab', '#FC6D26'], ['microsoft', 'microsoft', '#00A4EF'],
  ['azure', 'microsoft', '#00A4EF'], ['outlook', 'microsoft', '#0078D4'],
  ['office', 'microsoft', '#D83B01'], ['facebook', 'facebook', '#1877F2'],
  ['meta', 'meta', '#1877F2'], ['instagram', 'instagram', '#E4405F'],
  ['whatsapp', 'whatsapp', '#25D366'], ['twitter', 'x', '#000000'],
  ['x.com', 'x', '#000000'], ['paypal', 'paypal', '#003087'],
  ['binance', 'binance', '#F0B90B'], ['coinbase', 'coinbase', '#0052FF'],
  ['kraken', 'kraken', '#5741D9'], ['steam', 'steam', '#171A21'],
  ['epicgames', 'epicgames', '#313131'], ['epic games', 'epicgames', '#313131'],
  ['playstation', 'playstation', '#003087'], ['roblox', 'roblox', '#000000'],
  ['dropbox', 'dropbox', '#0061FF'], ['proton', 'proton', '#6D4AFF'],
  ['discord', 'discord', '#5865F2'], ['cloudflare', 'cloudflare', '#F38020'],
  ['digitalocean', 'digitalocean', '#0080FF'], ['apple', 'apple', '#000000'],
  ['npm', 'npm', '#CB3837'], ['bitwarden', 'bitwarden', '#175DDC'],
  ['openai', 'openai', '#412991'], ['chatgpt', 'openai', '#412991'],
  ['snapchat', 'snapchat', '#FFFC00'], ['tiktok', 'tiktok', '#000000'],
  ['spotify', 'spotify', '#1DB954'], ['linkedin', 'linkedin', '#0A66C2'],
  ['reddit', 'reddit', '#FF4500'], ['twitch', 'twitch', '#9146FF'],
  ['slack', 'slack', '#4A154B'], ['telegram', 'telegram', '#26A5E4'],
  ['docker', 'docker', '#2496ED'], ['kubernetes', 'kubernetes', '#326CE5'],
  ['wordpress', 'wordpress', '#21759B'], ['shopify', 'shopify', '#95BF47'],
  ['stripe', 'stripe', '#635BFF'], ['adobe', 'adobe', '#FA0F00'],
  ['ebay', 'ebay', '#E53238'], ['twilio', 'twilio', '#F22F46'],
  ['bitdefender', 'bitdefender', '#ED1C24'], ['authentik', 'authentik', '#FD4B2D'],
  ['lastpass', 'lastpass', '#D32D27'], ['auth0', 'auth0', '#EB5424'],
  ['okta', 'okta', '#007DC1'], ['hetzner', 'hetzner', '#D50C2D'],
  ['ovh', 'ovh', '#123F6D'], ['firefox', 'firefox', '#FF7139'],
  ['thunderbird', 'thunderbird', '#0A84FF'],
  ['proxmox', 'proxmox', '#E57000'], ['synology', 'synology', '#B5B5B6'],
  ['fortinet', 'fortinet', '#EE3124'], ['vmware', 'vmware', '#607078'],
  ['truenas', 'truenas', '#0095D5'], ['nextcloud', 'nextcloud', '#0082C9'],
  ['ubiquiti', 'ubiquiti', '#0559C9'], ['unifi', 'ubiquiti', '#0559C9'],
  ['mikrotik', 'mikrotik', '#293239'], ['pfsense', 'pfsense', '#212121'],
  ['opnsense', 'opnsense', '#D94F00'], ['tailscale', 'tailscale', '#242424'],
  ['zerotier', 'zerotier', '#FFB441'], ['wireguard', 'wireguard', '#88171A'],
  ['openvpn', 'openvpn', '#EA7E20'], ['grafana', 'grafana', '#F46800'],
  ['portainer', 'portainer', '#13BEF9'], ['bitbucket', 'bitbucket', '#0052CC'],
  ['atlassian', 'atlassian', '#0052CC'], ['jira', 'jira', '#0052CC'],
  ['notion', 'notion', '#000000'], ['figma', 'figma', '#F24E1E'],
  ['zoom', 'zoom', '#0B5CFF'], ['vercel', 'vercel', '#000000'],
  ['netlify', 'netlify', '#00C7B7'], ['heroku', 'heroku', '#430098'],
  ['godaddy', 'godaddy', '#1BDBDB'], ['namecheap', 'namecheap', '#DE3723'],
  ['porkbun', 'porkbun', '#EF7878'], ['ionos', 'ionos', '#003D8F'],
  ['backblaze', 'backblaze', '#E21E29'], ['mega', 'mega', '#D9272E'],
  ['icloud', 'icloud', '#3693F3'], ['vultr', 'vultr', '#007BFC'],
  ['1password', '1password', '#3B66BC'], ['keepass', 'keepassxc', '#6CAC4D'],
  ['dashlane', 'dashlane', '#0E353D'], ['nordvpn', 'nordvpn', '#4687FF'],
  ['protonvpn', 'protonvpn', '#66DEB1'], ['mullvad', 'mullvad', '#294D73'],
  ['revolut', 'revolut', '#191C1F'], ['n26', 'n26', '#48AC98'],
  ['wise', 'wise', '#9FE870'], ['kucoin', 'kucoin', '#01BC8D'],
  ['okx', 'okx', '#000000'], ['ubisoft', 'ubisoft', '#000000'],
  ['battle.net', 'battledotnet', '#4381C3'], ['blizzard', 'battledotnet', '#4381C3'],
  ['riot', 'riotgames', '#EB0029'], ['nvidia', 'nvidia', '#76B900'],
  ['samsung', 'samsung', '#1428A0'], ['xiaomi', 'xiaomi', '#FF6900'],
  ['huawei', 'huawei', '#FF0000'], ['logitech', 'logitech', '#00B8FC'],
  ['ea.com', 'ea', '#000000'], ['electronic arts', 'ea', '#000000'],
];

function matchBrand(name, issuer) {
  const t = `${name} ${issuer}`.toLowerCase();
  for (const [kw, slug, color] of BRANDS) {
    if (t.includes(kw)) return { slug, color };
  }
  return null;
}

module.exports = { BRANDS, matchBrand };
