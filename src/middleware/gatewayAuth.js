/**
 * Gateway Auth Middleware
 * Extracts user info from gateway-forwarded headers
 * Gateway sends x-user-id header after JWT authentication
 */

import mongoose from 'mongoose';

/**
 * Gateway authentication middleware
 * Trusts x-user-id header from gateway (already authenticated)
 */
export function gatewayAuth(req, res, next) {
  const userId = req.headers['x-user-id'];

  if (!userId) {
    return res.status(401).json({
      status: false,
      error: 'User ID required (x-user-id header missing)'
    });
  }

  // Validate ObjectId format
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(401).json({
      status: false,
      error: 'Invalid user ID format'
    });
  }

  // Set user context from gateway
  req.user = {
    _id: new mongoose.Types.ObjectId(userId),
    // Note: For role checks, we need to fetch from gateway-db or include in headers
    // For now, we trust gateway has already checked permissions
    fromGateway: true
  };

  next();
}

/**
 * Optional gateway auth - allows unauthenticated requests
 */
export function optionalGatewayAuth(req, res, next) {
  const userId = req.headers['x-user-id'];

  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    req.user = {
      _id: new mongoose.Types.ObjectId(userId),
      fromGateway: true
    };
  }

  next();
}

export default gatewayAuth;
