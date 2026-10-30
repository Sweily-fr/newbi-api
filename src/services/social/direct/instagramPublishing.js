import { isVideoMedia, videoCoverOffsetMs } from "../socialPostRules.js";
import { classifyMetaError, graphVersion } from "./metaApi.js";
import { DirectApiError, directRequest, timing } from "./directHttp.js";

/**
 * Publication Instagram commune aux deux connexions (mêmes appels, hôte et
 * jeton différents) :
 * - Instagram Login (instagramApi.js) : graph.instagram.com, jeton en
 *   en-tête Bearer ;
 * - Facebook Login for Business (instagramFacebookApi.js) :
 *   graph.facebook.com, jeton en paramètre, son tendance sur les Reels
 *   (audio_configuration, API Audio réservée à cette connexion).
 *
 * Photo et carrousel publiés tout de suite ; vidéo en Reel en deux temps
 * (conteneur, puis checkPublication) ; stories (media_type STORIES) : une
 * story par photo, publiées à la suite avec la progression enregistrée
 * après chacune (saveProgress), ou une vidéo en deux temps comme le Reel.
 * Pas de légende ni de couverture pour une story (non prévues par l'API).
 * Doc : developers.facebook.com/docs/instagram-platform/content-publishing/
 * (« Story posts »), /instagram-graph-api/reference/ig-user/media,
 * /documentation/instagram-platform/content-publishing/audio-api
 */

const CONTAINER_POLL_ATTEMPTS = 10;
const CONTAINER_POLL_DELAY_MS = 3000;
const PUBLISH_TIMEOUT_MS = 60000;
// Reel et story vidéo : statut du conteneur lu une fois par minute (conseil
// de Meta)
export const VIDEO_CHECK_MS = 60 * 1000;

/** Volume Meta : entier de 1 à 100 (0 est envoyé comme 1). */
export const metaVolume = (value) =>
  Math.min(100, Math.max(1, Math.round(Number(value) || 0)));

const mentionsAudio = (error) =>
  /audio/i.test(`${error?.message || ""} ${error?.detail || ""}`);

/**
 * @param {object} options
 * @param {string} options.network - réseau des erreurs (« instagram »)
 * @param {string} options.graphUrl - hôte de l'API Graph
 * @param {"header"|"query"} options.tokenIn - jeton en en-tête Bearer ou en
 *   paramètre access_token
 * @param {Function} options.classify - classement des réponses en erreur
 * @param {boolean} [options.sounds] - son tendance possible sur les Reels
 */
export function createInstagramPublisher({
  network,
  graphUrl,
  tokenIn,
  classify,
  sounds = false,
}) {
  const graph = (method, path, { token, query, json, timeoutMs } = {}) =>
    directRequest({
      network,
      method,
      url: `${graphUrl}/${graphVersion()}/${path}`,
      headers:
        token && tokenIn === "header"
          ? { Authorization: `Bearer ${token}` }
          : {},
      // Jeton en paramètre (méthode documentée) ; jamais journalisé
      query:
        token && tokenIn === "query"
          ? { ...query, access_token: token }
          : query,
      json,
      timeoutMs,
      check: classify,
    });

  /**
   * Conteneur en erreur → DirectApiError classée (« status » porte le
   * sous-code, ex. 2207009 : format). Vidéo : refus de la vidéo ; son
   * mentionné : son refusé.
   */
  function containerError(data, { video = false, sound = false } = {}) {
    const subcode = Number(String(data?.status || "").match(/\d{7}/)?.[0]);
    const error = classifyMetaError(
      { ok: false, status: 400, headers: null },
      {
        error: {
          message: data?.status || "Conteneur en erreur",
          code: 100,
          error_subcode: subcode || null,
        },
      },
      "container",
      network,
    );
    const refused =
      !error.transient &&
      !error.authInvalid &&
      ["platform_rejected", "user_content"].includes(error.category);
    if (refused && sound && mentionsAudio(error)) {
      error.category = "sound_rejected";
    } else if (refused && video) {
      error.category = "video_rejected";
    }
    return error;
  }

  /** Attend qu'un conteneur soit prêt (FINISHED). */
  async function waitForContainer(containerId, token) {
    for (let attempt = 1; attempt <= CONTAINER_POLL_ATTEMPTS; attempt += 1) {
      const { data } = await graph("GET", containerId, {
        token,
        query: { fields: "status_code,status" },
      });
      const status = data?.status_code;
      if (status === "FINISHED" || status === "PUBLISHED") return;
      if (status === "ERROR") throw containerError(data);
      if (status === "EXPIRED") {
        throw new DirectApiError(`${network} : conteneur expiré`, {
          network,
          transient: true,
        });
      }
      await timing.sleep(CONTAINER_POLL_DELAY_MS);
    }
    throw new DirectApiError(`${network} : conteneur pas encore prêt`, {
      network,
      transient: true,
    });
  }

  async function createContainer(igUserId, accessToken, json) {
    const { data } = await graph("POST", `${igUserId}/media`, {
      token: accessToken,
      json,
      timeoutMs: PUBLISH_TIMEOUT_MS,
    });
    if (!data?.id) {
      throw new DirectApiError(`${network} : conteneur sans identifiant`, {
        network,
        status: 502,
        transient: true,
      });
    }
    return String(data.id);
  }

  /** Publie un conteneur prêt → identifiant du média publié. */
  async function publishContainerId(igUserId, containerId, accessToken) {
    const { data } = await graph("POST", `${igUserId}/media_publish`, {
      token: accessToken,
      json: { creation_id: containerId },
      timeoutMs: PUBLISH_TIMEOUT_MS,
    });
    if (!data?.id) {
      throw new DirectApiError(`${network} : publication sans identifiant`, {
        network,
        status: 502,
        transient: true,
      });
    }
    return String(data.id);
  }

  /** Adresse d'un média publié (au mieux). */
  async function permalinkOf(mediaId, accessToken) {
    if (!mediaId) return null;
    try {
      const { data } = await graph("GET", String(mediaId), {
        token: accessToken,
        query: { fields: "permalink" },
      });
      return data?.permalink || null;
    } catch {
      // Publié : l'adresse manquante ne doit pas faire croire à un échec
      return null;
    }
  }

  /** Publie un conteneur prêt, puis lit l'adresse du post (au mieux). */
  async function publishContainer(igUserId, containerId, accessToken) {
    const id = await publishContainerId(igUserId, containerId, accessToken);
    return {
      status: "published",
      externalPostId: id,
      platformPostUrl: await permalinkOf(id, accessToken),
    };
  }

  const twoStepResult = (containerId) => ({
    status: "publishing",
    externalPostId: null,
    processingRef: containerId,
    platformPostUrl: null,
    nextCheckMs: VIDEO_CHECK_MS,
  });

  /**
   * Reel : conteneur créé (Instagram va chercher la vidéo à notre adresse),
   * publié plus tard par checkPublication. Son tendance (connexion via
   * Facebook seulement) : audio_configuration, volumes de 1 à 100.
   */
  async function publishReel({ account, accessToken, content, video, sound }) {
    const withSound = Boolean(sounds && sound?.soundId);
    let containerId;
    try {
      containerId = await createContainer(
        account.externalAccountId,
        accessToken,
        {
          media_type: "REELS",
          video_url: video.url,
          share_to_feed: true,
          thumb_offset: videoCoverOffsetMs(video.durationMs),
          ...(content ? { caption: content } : {}),
          ...(withSound
            ? {
                audio_configuration: JSON.stringify({
                  audio_id: sound.soundId,
                  audio_volume: metaVolume(sound.volume),
                  video_volume: metaVolume(sound.videoVolume),
                }),
              }
            : {}),
        },
      );
    } catch (error) {
      if (
        withSound &&
        error instanceof DirectApiError &&
        !error.transient &&
        !error.authInvalid &&
        mentionsAudio(error)
      ) {
        error.category = "sound_rejected";
      }
      throw error;
    }
    return twoStepResult(containerId);
  }

  /**
   * Stories photo : une story par photo, dans l'ordre, en reprenant après
   * la dernière déjà publiée (progress.storyIds) ; progression enregistrée
   * après chaque story (un nouvel essai ne republie jamais une story).
   */
  async function publishPhotoStories({
    account,
    accessToken,
    media,
    progress,
    saveProgress,
  }) {
    const igUserId = account.externalAccountId;
    const storyIds = [...(progress?.storyIds || [])];
    for (let index = storyIds.length; index < media.length; index += 1) {
      const containerId = await createContainer(igUserId, accessToken, {
        media_type: "STORIES",
        image_url: media[index].url,
      });
      await waitForContainer(containerId, accessToken);
      storyIds.push(
        await publishContainerId(igUserId, containerId, accessToken),
      );
      if (saveProgress) await saveProgress({ storyIds: [...storyIds] });
    }
    return {
      status: "published",
      externalPostId: storyIds[0] || null,
      platformPostUrl: await permalinkOf(storyIds[0], accessToken),
      storyIds,
    };
  }

  /** Story vidéo : conteneur STORIES, publié par checkPublication. */
  async function publishVideoStory({ account, accessToken, video, progress }) {
    const done = progress?.storyIds || [];
    if (done.length > 0) {
      // Déjà publiée (résultat perdu) : rien à republier
      return {
        status: "published",
        externalPostId: done[0],
        platformPostUrl: await permalinkOf(done[0], accessToken),
        storyIds: [...done],
      };
    }
    const containerId = await createContainer(
      account.externalAccountId,
      accessToken,
      { media_type: "STORIES", video_url: video.url },
    );
    return twoStepResult(containerId);
  }

  /**
   * Suivi d'un Reel ou d'une story vidéo : conteneur prêt → publié ; en
   * cours → à relire ; en erreur → refus ; expiré (jamais publié) →
   * publication à reprendre.
   */
  async function checkPublication({
    account,
    accessToken,
    processingRef,
    instagramSettings = null,
    progress = null,
    saveProgress = null,
  }) {
    const story = instagramSettings?.format === "story";
    const { data } = await graph("GET", processingRef, {
      token: accessToken,
      query: { fields: "status_code,status" },
    });
    const status = data?.status_code;
    if (status === "FINISHED") {
      const result = await publishContainer(
        account.externalAccountId,
        processingRef,
        accessToken,
      );
      if (!story) return result;
      const storyIds = [result.externalPostId];
      if (saveProgress) await saveProgress({ storyIds });
      return { ...result, storyIds };
    }
    if (status === "PUBLISHED") {
      // Publié au tour précédent (réponse perdue) : identifiant inconnu
      const known = progress?.storyIds?.[0] || null;
      return {
        status: "published",
        externalPostId: known,
        platformPostUrl: null,
        ...(story && known ? { storyIds: [known] } : {}),
      };
    }
    if (status === "ERROR") {
      throw containerError(data, {
        video: true,
        sound: Boolean(sounds && !story && instagramSettings?.sound?.soundId),
      });
    }
    if (status === "EXPIRED") {
      throw new DirectApiError(`${network} : conteneur expiré`, {
        network,
        transient: true,
        restart: true,
      });
    }
    return { status: "publishing", nextCheckMs: VIDEO_CHECK_MS };
  }

  /**
   * Publie une image ou un carrousel (2 à 10 images), lance un Reel (une
   * vidéo), ou publie en story (instagramSettings.format « story »). Les
   * médias doivent être à une adresse publique (Instagram va les chercher).
   */
  async function publish({
    account,
    accessToken,
    content,
    media,
    instagramSettings = null,
    progress = null,
    saveProgress = null,
  }) {
    const video = media.length === 1 && isVideoMedia(media[0]);
    if (instagramSettings?.format === "story") {
      return video
        ? publishVideoStory({ account, accessToken, video: media[0], progress })
        : publishPhotoStories({
            account,
            accessToken,
            media,
            progress,
            saveProgress,
          });
    }
    if (video) {
      return publishReel({
        account,
        accessToken,
        content,
        video: media[0],
        sound: instagramSettings?.sound || null,
      });
    }
    const igUserId = account.externalAccountId;
    const create = (json) => createContainer(igUserId, accessToken, json);

    let containerId;
    if (media.length === 1) {
      containerId = await create({
        image_url: media[0].url,
        ...(content ? { caption: content } : {}),
      });
    } else {
      const children = [];
      for (const item of media) {
        children.push(
          await create({ image_url: item.url, is_carousel_item: true }),
        );
      }
      containerId = await create({
        media_type: "CAROUSEL",
        children: children.join(","),
        ...(content ? { caption: content } : {}),
      });
    }
    await waitForContainer(containerId, accessToken);
    return publishContainer(igUserId, containerId, accessToken);
  }

  return { graph, publish, checkPublication };
}
