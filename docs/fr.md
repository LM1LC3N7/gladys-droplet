# Droplet

Intégration non officielle, sans lien avec Hydrific ni LIXIL. Elle lit un
capteur de débit d'eau **Droplet** (à clipser sur le tuyau) sur votre réseau
domestique, sans cloud, par le WebSocket local qu'ouvre le Droplet (firmware
1.4.0 ou plus récent), comme le fait pydroplet, la bibliothèque d'Hydrific.
**Lecture seule** : aucun réglage ni aucune commande n'est jamais envoyé au
Droplet. **Jamais testé
avec un vrai Droplet** : elle a été construite d'après pydroplet et testée sur
un faux ; dites-nous ce que vous voyez.

## Installation

1. Dans l'application Droplet, trouvez le **code d'appairage** pour l'accès
   local.
2. Donnez au Droplet une adresse IP fixe dans votre box.
3. Dans Gladys, remplissez **Adresse du Droplet** (ex. `192.168.1.30`, un port
   seulement s'il n'est pas 443) et **Code d'appairage**, puis enregistrez.
4. Le statut affiche `Connecté au Droplet <id>` dès que le Droplet a envoyé son
   identifiant. Créez l'appareil dans l'onglet **Découverte**.

Le code d'appairage est gardé par Gladys dans sa base, jamais réaffiché, et
envoyé seulement au Droplet, en TLS, après vérification de son certificat.

## Ce que vous obtenez

| Fonction             | Unité | Remarques                                                 |
| -------------------- | ----- | --------------------------------------------------------- |
| Débit                | m³/h  | le Droplet donne des L/min (1 L/min = 0,06 m³/h)          |
| Index d'eau          | L     | construit à partir des relevés de volume, voir plus bas   |
| Connexion au serveur | texte | tel que le Droplet le dit (ex. « Connected »)             |
| Qualité du signal    | texte | signal ultrasonore, tel que le Droplet le dit             |
| Fuite                | 0/1   | débit au-dessus du seuil réglé dans l'application Droplet |
| Débit inhabituel     | 0/1   | chasse d'eau qui fuit, fuite lente                        |

Fuite et débit inhabituel ne sont connus que lorsque le Droplet joint les
serveurs Hydrific. Les valeurs instantanées partent vers Gladys au plus toutes
les 10 secondes ; une valeur de plus de 2 minutes n'est pas renvoyée comme
neuve (après un redémarrage de Gladys, un appareil créé).

## L'index d'eau

Le Droplet n'a pas de compteur : il relève le volume écoulé depuis son relevé
précédent (en mL, parfois négatif). L'intégration additionne les relevés en un
index en litres, gardé dans /data d'un redémarrage à l'autre, publié une fois
par minute après que /data l'a enregistré. Ses règles :

- il ne vaut jamais 0 et ne baisse jamais : un relevé négatif diminue le total,
  et l'index attend que le total repasse au-dessus (le statut dit de combien
  dès 1 L) ;
- un relevé plus grand que ce que 200 L/min (environ 53 gallons US/min)
  apportent dans le temps écoulé depuis le relevé précédent (compté jusqu'à
  10 minutes), plus 10 L, est **retenu** : affiché dans le statut (pastille
  orange), gardé dans /data, jamais compté par le temps ni par la répétition.
  Les relevés suivants comptent normalement. Si c'est juste, cliquez deux fois
  sur **Accepter le volume retenu** (de 3 secondes à 5 minutes d'écart) : le
  second clic ajoute exactement ce que le premier a listé. Un relevé négatif
  aussi grand est ignoré (compté dans le statut) ;
- les volumes relevés avant que le Droplet donne son identifiant comptent pour
  ce Droplet dès qu'il l'a donné ; les volumes écoulés quand l'intégration
  n'est pas connectée au Droplet ne sont pas connus (l'index reste où il
  était) ;
- si Gladys a déjà un index plus grand que /data (/data perdu), l'index repart
  de la valeur de Gladys ;
- un autre Droplet à l'adresse (remplacement) est un autre appareil, avec son
  propre index. Supprimer puis recréer l'appareil garde l'index.

## Connexion

- Une connexion à la fois. Une connexion qui se termine est rouverte 30
  secondes après l'essai précédent ; tant qu'elle échoue, après 30 s, 1, 2, 4... jusqu'à 30
  minutes. Jamais deux essais à moins de 30 secondes, quoi qui le demande
  (bouton de test, enregistrement, redémarrage : l'heure de l'essai est gardée
  dans /data).
- Un ping toutes les 30 secondes : sans réponse sous 15 secondes, la connexion
  est fermée et rouverte plus tard.
- **Code d'appairage refusé** (HTTP 401/403 à l'ouverture ou, avec un firmware
  1.4.1 ou plus ancien, connexion fermée par le Droplet avant tout message,
  deux fois de suite) : plus rien n'est tenté de soi-même tant que vous
  n'enregistrez pas à nouveau le code ou que le bouton **Tester la connexion**
  n'obtient pas de connexion (un essai par clic, au rythme ci-dessus).
- HTTP 429 ou 5xx à l'ouverture : pause d'une minute, doublée jusqu'à 6 heures,
  gardée d'un redémarrage à l'autre.
- **Certificat** : épinglé à la première connexion (écrit dans /data avant
  l'envoi du code). Un autre certificat ensuite : rien n'est envoyé et le
  statut affiche son empreinte ; si vous avez remplacé ou réinitialisé le
  Droplet, copiez-la dans **Empreinte du certificat** et enregistrez.
- /data illisible : aucun certificat n'est appris (rien n'est envoyé sans
  empreinte saisie), l'index n'est pas publié (ses volumes sont gardés en
  mémoire et ajoutés dès que /data se lit à nouveau), et le fichier n'est
  jamais écrasé.

## Boutons

- **Tester la connexion** : une fois connecté, le débit et l'index ; sinon un
  essai quand il est dû.
- **Accepter le volume retenu** : voir « L'index d'eau ».

## Non fait

Pas de découverte sur le réseau (saisissez l'adresse), pas de réglage du
Droplet, pas d'historique du cloud Hydrific.
