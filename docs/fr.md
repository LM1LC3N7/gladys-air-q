# air-Q

**Connecteur non officiel, sans lien avec Corant GmbH.** Il amène dans Gladys
les valeurs de vos capteurs de qualité de l'air **air-Q**, lues directement
sur votre réseau local : sans cloud, sans compte, sans abonnement.

> **Cette intégration n'a jamais été testée avec un vrai air-Q.** Elle suit
> aioairq, la bibliothèque Python du fabricant qu'utilise Home Assistant.
> Merci de signaler ce que vous constatez sur le forum Gladys.

## Ce que vous obtenez

Un appareil par air-Q, au nom que vous lui avez donné dans l'application
air-Q, avec les valeurs que mesure votre modèle (une valeur que l'appareil
n'envoie pas n'est simplement pas créée) :

| Capteur dans Gladys   | Champ air-Q          | Unité |
| --------------------- | -------------------- | ----- |
| CO2                   | `co2`                | ppm   |
| COV                   | `tvoc`               | ppb   |
| COV (capteur ionique) | `tvoc_ionsc`         | ppb   |
| PM2.5, PM10           | `pm2_5`, `pm10`      | µg/m³ |
| Monoxyde de carbone   | `co`                 | ppm   |
| Dioxyde d'azote       | `no2`                | µg/m³ |
| Ozone                 | `o3`                 | µg/m³ |
| Dioxyde de soufre     | `so2`                | µg/m³ |
| Formaldéhyde          | `ch2o_M10`           | µg/m³ |
| Température           | `temperature`        | °C    |
| Humidité              | `humidity`           | %     |
| Pression              | `pressure`           | hPa   |
| Bruit, bruit (crête)  | `sound`, `sound_max` | dB(A) |

- L'air-Q donne le monoxyde de carbone en mg/m³ ; Gladys ne connaît que le
  ppm pour lui : la valeur est convertie (× 0,873, à 25 °C et pression
  normale).
- Pas encore dans Gladys, faute de catégorie pour eux : radon, oxygène, PM1,
  comptages de particules, humidité absolue, indices « santé » et
  « performance », indices virus et moisissures, point de rosée (une
  température qui fausserait celle de la pièce), gaz plus rares de l'air-Q
  Science. Voir TODO.md.
- Un capteur encore en chauffe après un redémarrage de l'air-Q n'envoie pas
  de valeur pendant un moment : sa fonction reste, la valeur revient seule.
- Les noms des capteurs sont en anglais ; renommez-les à la création si vous
  le souhaitez.

## Installation

1. Donnez à l'air-Q une **adresse IP fixe** dans votre box (réservation
   DHCP) : l'intégration le joint par son adresse. Dans le conteneur de
   l'intégration, les noms mDNS (`<id>_air-q.local`) ne sont en général pas
   résolus.
2. Installez l'intégration depuis le catalogue Gladys (Gladys 5.1 ou plus
   récent).
3. Dans l'écran **Configuration**, saisissez l'adresse et le **mot de passe
   de l'appareil**, puis enregistrez. Jusqu'à trois air-Q.
4. Cliquez sur **Tester les air-Q** : le message affiche les principales
   valeurs de chacun.
5. Ouvrez l'onglet **Découverte** et ajoutez les appareils. Leurs valeurs
   arrivent dès leur création.

## Configuration

- **Adresse** : l'adresse IPv4 de l'air-Q (`192.168.1.50`), avec un port si
  besoin, ou son nom d'hôte ; l'identifiant de 5 caractères imprimé sur
  l'appareil devient `<id>_air-q.local`, comme dans aioairq, pour un réseau
  qui résout les noms mDNS. Un chemin, une adresse IPv6 ou des identifiants
  sont refusés.
- **Mot de passe** : le mot de passe de l'appareil défini dans l'application
  air-Q (`airqsetup` à la livraison : changez-le dans l'application). Il est
  gardé par Gladys dans sa base (en clair, comme tout champ secret de
  Gladys) et jamais réaffiché dans l'écran de configuration. Il ne quitte
  jamais l'intégration : l'air-Q protège ses réponses en AES-256 avec une
  clé tirée de ce mot de passe, et l'intégration s'en sert seulement pour
  les ouvrir. Il n'est jamais écrit dans les journaux ni sous `/data`.
- **Valeurs** : moyennées (lissées par l'air-Q, le choix par défaut de son
  application et de Home Assistant) ou instantanées.
- **Intervalle de lecture** : 2 minutes par défaut, de 1 à 60.

## À quel rythme l'air-Q est lu

- Au démarrage, `GET /config` (l'identifiant et le nom de l'appareil) puis
  `GET /average` (ou `/data`) ; ensuite une requête par air-Q à chaque
  intervalle. Une reconnexion à Gladys ne lit rien de plus que ce qui est dû.
- **Lecture seule** : l'intégration n'écrit jamais sur l'air-Q (aucun
  changement de configuration, aucun clignotement, aucun redémarrage).
- Un échec (pas de réponse, autre statut HTTP, réponse qui n'est pas celle
  d'un air-Q) est réessayé à l'intervalle suivant, jamais plus tôt.
- Quand l'air-Q répond **429 ou 5xx** (occupé, en redémarrage), il est
  laissé tranquille pendant le délai `Retry-After` qu'il donne, sinon
  5 minutes, puis 10, 20… ; toujours entre 1 minute et 6 heures, et jamais
  moins que l'intervalle.
- Quand le **mot de passe ne convient pas** (la réponse ne s'ouvre pas), les
  lectures de cet air-Q s'arrêtent et le statut le dit ; un nouvel essai
  toutes les 6 heures (le bouton de test peut réessayer tout de suite),
  jusqu'à ce que vous changiez le mot de passe.
- Les pauses et les refus survivent à une reconnexion à Gladys et à un
  redémarrage du conteneur : ils sont gardés dans un fichier sous `/data`
  avec, pour un refus, une empreinte salée (scrypt) du mot de passe, jamais
  le mot de passe ; un nouveau mot de passe est essayé tout de suite.
- Une réponse de plus de 256 Ko, ou de plus de 10 secondes, est abandonnée.

## Dépannage

- **« mot de passe refusé »** : vérifiez le mot de passe de l'appareil dans
  l'application air-Q (celui de l'appareil, pas celui de votre compte air-Q).
- **« pas de réponse »** : vérifiez l'adresse (IP fixe), que l'air-Q est sur
  le même réseau que Gladys et que son Wi-Fi n'est pas coupé par le mode
  nuit.
- **« réponse qui n'est pas celle d'un air-Q »** : l'adresse mène à un autre
  appareil.
- **« même air-Q qu'une autre adresse »** : deux adresses mènent au même
  appareil ; n'en gardez qu'une.
- Journaux : le niveau se règle avec la variable `LOG_LEVEL`.

## Vie privée

Tout reste sur votre réseau local : l'intégration ne parle qu'aux adresses
que vous saisissez, en HTTP (l'air-Q n'a pas de HTTPS), et ses réponses sont
protégées par l'appareil lui-même. Ni cloud, ni compte.

## Remerciements

Construit d'après [aioairq](https://github.com/CorantGmbH/aioairq)
(Apache-2.0, Corant GmbH, le fabricant de l'air-Q), la bibliothèque de
l'intégration air-Q de Home Assistant : la protection de l'API locale, les
routes, les champs et le traitement des valeurs sont portés en JavaScript.
Sa notice est dans `THIRD_PARTY_NOTICES.md`. air-Q est une marque de son
propriétaire ; ce connecteur est gratuit et non officiel.
