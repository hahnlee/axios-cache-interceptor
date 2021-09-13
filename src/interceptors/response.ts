import { AxiosResponse } from 'axios';
import { AxiosCacheInstance, CacheRequestConfig } from '../axios/types';
import { CachedStorageValue } from '../storage/types';
import { checkPredicateObject } from '../util/cache-predicate';
import { updateCache } from '../util/update-cache';

export function applyResponseInterceptor(axios: AxiosCacheInstance): void {
  const testCachePredicate = (response: AxiosResponse, config: CacheRequestConfig): boolean => {
    const cachePredicate = config.cache?.cachePredicate || axios.defaults.cache.cachePredicate;

    return (
      (typeof cachePredicate === 'function' && cachePredicate(response)) ||
      (typeof cachePredicate === 'object' && checkPredicateObject(response, cachePredicate))
    );
  };

  axios.interceptors.response.use(async (response) => {
    const key = axios.generateKey(response.config);
    const cache = await axios.storage.get(key);

    // Response is empty or was already cached
    if (cache.state !== 'loading') {
      return response;
    }

    // Config told that this response should be cached.
    if (!testCachePredicate(response, response.config)) {
      // Update the cache to empty to prevent infinite loading state
      await axios.storage.remove(key);
      return response;
    }

    let expiration = Date.now() + (response.config.cache?.maxAge || axios.defaults.cache.maxAge);

    if (response.config.cache?.interpretHeader) {
      const expirationTime = axios.headerInterpreter(response.headers['cache-control']);

      // Cache should not be used
      if (expirationTime === false) {
        // Update the cache to empty to prevent infinite loading state
        await axios.storage.remove(key);
        return response;
      }

      expiration = expirationTime ? expirationTime : expiration;
    }

    const newCache: CachedStorageValue = {
      data: { body: response.data, headers: response.headers },
      state: 'cached',
      expiration: expiration
    };

    // Update other entries before updating himself
    if (response.config.cache?.update) {
      updateCache(axios, response.data, response.config.cache.update);
    }

    const deferred = axios.waiting[key];

    // Resolve all other requests waiting for this response
    if (deferred) {
      await deferred.resolve(newCache.data);
    }

    await axios.storage.set(key, newCache);

    return response;
  });
}